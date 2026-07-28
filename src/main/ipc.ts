import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { CH } from '@shared/ipc-contract'
import type { KvmReplyEnvelope } from '@shared/ipc-contract'
import type { ApprovalDecision, ApprovalMode, ConnectionStatus, SettingsPatch, StartSessionInput } from '@shared/types'
import { loadSettings, saveSettings, validateSettings } from './settings'
import { getElevationStatus, relaunchAsAdmin } from './system'
import { sessionManager } from './orchestrator/manager'
import { kvmBridge } from './kvmBridge'
import { signalWebrtc } from './kvmSignaling'
import { discovery } from './discovery'
import { setPreferredTarget } from './kvmResolve'
import type { KvmTargetSelection } from '@shared/ipc-contract'
import { setLogBroadcaster } from './logger'
import { checkForUpdates, currentUpdateStatus, quitAndInstall, setUpdateBroadcaster } from './updater'
import { onNativeSnapshot } from './nativeShell'
import { copySummaryToClipboard, exportSummaryToFile } from './sessionExport'

/**
 * Register every IPC handler and wire the main → renderer broadcasters. Called
 * once, after the main window exists.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // Settings & system --------------------------------------------------------
  ipcMain.handle(CH.getSettings, () => loadSettings())
  ipcMain.handle(CH.saveSettings, (_e, patch: SettingsPatch) => saveSettings(patch))
  ipcMain.handle(CH.validateSettings, (_e, input) => validateSettings(input))
  ipcMain.handle(CH.getElevation, () => getElevationStatus())
  ipcMain.handle(CH.relaunchAsAdmin, () => relaunchAsAdmin())
  ipcMain.handle(CH.getAppVersion, () => app.getVersion())
  ipcMain.handle(CH.pickDirectory, async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  // Session control ----------------------------------------------------------
  ipcMain.handle(CH.startSession, (_e, input: StartSessionInput) => sessionManager.start(input))
  ipcMain.handle(CH.pauseSession, () => sessionManager.pause())
  ipcMain.handle(CH.resumeSession, () => sessionManager.resume())
  ipcMain.handle(CH.stopSession, () => sessionManager.stop())
  ipcMain.handle(CH.setApprovalMode, (_e, mode: ApprovalMode) => sessionManager.setApprovalMode(mode))
  ipcMain.handle(CH.setManualControl, (_e, enabled: boolean) => sessionManager.setManualControl(enabled))
  ipcMain.handle(CH.submitApproval, (_e, actionId: string, decision: ApprovalDecision) =>
    sessionManager.submitApproval(actionId, decision)
  )
  ipcMain.handle(CH.sendChat, (_e, text: string) => sessionManager.sendChat(text))
  ipcMain.handle(CH.idleChat, (_e, text: string) => sessionManager.idleChat(text))
  ipcMain.handle(CH.getSnapshot, () => sessionManager.getSnapshot())
  ipcMain.handle(CH.exportSummary, () => exportSummaryToFile(getWindow(), false))
  ipcMain.handle(CH.copySummary, () => copySummaryToClipboard(getWindow(), false))

  // Updates ------------------------------------------------------------------
  ipcMain.handle(CH.checkForUpdates, () => checkForUpdates(false))
  ipcMain.handle(CH.quitAndInstall, () => quitAndInstall())

  // Device discovery + selection (IP is ephemeral, never persisted) ----------
  ipcMain.handle(CH.discoverDevices, (_e, useTls: boolean) => discovery.discover(useTls))
  ipcMain.handle(CH.selectKvmTarget, (_e, selection: KvmTargetSelection) => {
    // Parse "ip" or "ip:port"; store as a transient preferred target only.
    const trimmed = selection.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    const [host, portStr] = trimmed.split(':')
    const port = portStr ? Number(portStr) : selection.useTls ? 443 : 80
    setPreferredTarget({ host: host || '', port, useTls: selection.useTls })
  })
  ipcMain.handle(CH.forgetKvmTarget, async () => {
    setPreferredTarget(null)
    const cur = loadSettings()
    await saveSettings({ kvm: { deviceId: null, deviceName: null, hostname: null, useTls: cur.kvm.useTls, authMode: cur.kvm.authMode } })
  })

  // KVM bridge (renderer → main) ---------------------------------------------
  ipcMain.handle(CH.kvmSignal, (_e, offerB64: string) => signalWebrtc(offerB64))
  ipcMain.on(CH.kvmReply, (_e, env: KvmReplyEnvelope) => kvmBridge.handleReply(env))
  ipcMain.on(CH.kvmStatus, (_e, status: ConnectionStatus) => kvmBridge.handleStatus(status))

  // Broadcasters -------------------------------------------------------------
  setLogBroadcaster((e) => send(CH.evLog, e))
  sessionManager.setBroadcaster((s) => {
    send(CH.evSessionUpdate, s)
    // Drive the native title / notifications / taskbar attention off the same feed.
    onNativeSnapshot(s)
  })
  kvmBridge.onStatus((s) => send(CH.evConnectionUpdate, s))
  setUpdateBroadcaster((s) => send(CH.evUpdateStatus, s))

  // Push the current update status once the renderer is ready.
  const win = getWindow()
  win?.webContents.once('did-finish-load', () => send(CH.evUpdateStatus, currentUpdateStatus()))
}

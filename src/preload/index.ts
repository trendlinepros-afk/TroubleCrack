import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc-contract'
import type {
  KvmCommandEnvelope,
  KvmReplyEnvelope,
  MenuAction,
  SummaryExportResult,
  TroubleCrackApi,
  UpdateCheckResult
} from '@shared/ipc-contract'
import type {
  ApprovalDecision,
  ApprovalMode,
  ConnectionStatus,
  KvmSettings,
  LogEvent,
  Settings,
  SettingsPatch,
  SettingsValidation,
  SessionSnapshot,
  StartSessionInput,
  UpdateStatus
} from '@shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: TroubleCrackApi = {
  getSettings: () => ipcRenderer.invoke(CH.getSettings) as Promise<Settings>,
  saveSettings: (patch: SettingsPatch) => ipcRenderer.invoke(CH.saveSettings, patch) as Promise<Settings>,
  validateSettings: (input: { kvm: KvmSettings; anthropicApiKeyPlaintext?: string | null; vaultPath: string | null }) =>
    ipcRenderer.invoke(CH.validateSettings, input) as Promise<SettingsValidation>,
  getElevation: () => ipcRenderer.invoke(CH.getElevation),
  relaunchAsAdmin: () => ipcRenderer.invoke(CH.relaunchAsAdmin),
  getAppVersion: () => ipcRenderer.invoke(CH.getAppVersion) as Promise<string>,
  pickDirectory: () => ipcRenderer.invoke(CH.pickDirectory) as Promise<string | null>,

  startSession: (input: StartSessionInput) => ipcRenderer.invoke(CH.startSession, input) as Promise<SessionSnapshot>,
  pauseSession: () => ipcRenderer.invoke(CH.pauseSession) as Promise<void>,
  resumeSession: () => ipcRenderer.invoke(CH.resumeSession) as Promise<void>,
  stopSession: () => ipcRenderer.invoke(CH.stopSession) as Promise<void>,
  setApprovalMode: (mode: ApprovalMode) => ipcRenderer.invoke(CH.setApprovalMode, mode) as Promise<void>,
  setManualControl: (enabled: boolean) => ipcRenderer.invoke(CH.setManualControl, enabled) as Promise<void>,
  submitApproval: (actionId: string, decision: ApprovalDecision) =>
    ipcRenderer.invoke(CH.submitApproval, actionId, decision) as Promise<void>,
  sendChat: (text: string) => ipcRenderer.invoke(CH.sendChat, text) as Promise<void>,
  idleChat: (text: string) => ipcRenderer.invoke(CH.idleChat, text),
  getSnapshot: () => ipcRenderer.invoke(CH.getSnapshot) as Promise<SessionSnapshot | null>,
  exportSummary: () => ipcRenderer.invoke(CH.exportSummary) as Promise<SummaryExportResult>,
  copySummary: () => ipcRenderer.invoke(CH.copySummary) as Promise<SummaryExportResult>,

  checkForUpdates: () => ipcRenderer.invoke(CH.checkForUpdates) as Promise<UpdateCheckResult>,
  quitAndInstall: () => ipcRenderer.invoke(CH.quitAndInstall) as Promise<void>,

  discoverDevices: (useTls: boolean) => ipcRenderer.invoke(CH.discoverDevices, useTls),
  selectKvmTarget: (selection) => ipcRenderer.invoke(CH.selectKvmTarget, selection) as Promise<void>,
  forgetKvmTarget: () => ipcRenderer.invoke(CH.forgetKvmTarget) as Promise<void>,
  kvmSignal: (offerB64: string) => ipcRenderer.invoke(CH.kvmSignal, offerB64),
  onKvmCommand: (handler: (env: KvmCommandEnvelope) => void) => on<KvmCommandEnvelope>(CH.evKvmCommand, handler),
  replyKvmCommand: (reply: KvmReplyEnvelope) => ipcRenderer.send(CH.kvmReply, reply),
  reportKvmStatus: (status: ConnectionStatus) => ipcRenderer.send(CH.kvmStatus, status),

  onSessionUpdate: (cb: (s: SessionSnapshot) => void) => on<SessionSnapshot>(CH.evSessionUpdate, cb),
  onConnectionUpdate: (cb: (c: ConnectionStatus) => void) => on<ConnectionStatus>(CH.evConnectionUpdate, cb),
  onLog: (cb: (e: LogEvent) => void) => on<LogEvent>(CH.evLog, cb),
  onUpdateStatus: (cb: (u: UpdateStatus) => void) => on<UpdateStatus>(CH.evUpdateStatus, cb),
  onMenuAction: (cb: (action: MenuAction) => void) => on<MenuAction>(CH.evMenuAction, cb)
}

contextBridge.exposeInMainWorld('api', api)

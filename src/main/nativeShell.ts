import {
  app,
  dialog,
  Menu,
  Notification,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions
} from 'electron'
import { CH } from '@shared/ipc-contract'
import type { MenuAction } from '@shared/ipc-contract'
import type { SessionRunState, SessionSnapshot } from '@shared/types'
import { createLogger } from './logger'
import { sessionManager } from './orchestrator/manager'
import { checkForUpdates } from './updater'
import { copySummaryToClipboard, exportSummaryToFile } from './sessionExport'

/**
 * The "native shell": everything that makes TroubleCrack feel like a real desktop
 * app rather than a web page — the application menu with real accelerators, OS
 * notifications + taskbar attention when something needs the operator while the
 * window is in the background, a live window title, and a guard so quitting
 * mid-repair asks first.
 */

const logger = createLogger('native-shell')
const isMac = process.platform === 'darwin'

let win: BrowserWindow | null = null
let forceQuit = false

// Edge-detection state so notifications fire once per transition, not per frame.
let lastApprovalId: string | null = null
let lastRunState: SessionRunState | null = null
let lastNeedsHuman = false
let lastTitle = ''

/** Install the menu, quit guard, and focus handling on the main window. */
export function attachNativeShell(window: BrowserWindow): void {
  win = window
  buildMenu()

  // Stop flashing the taskbar the moment the operator looks at the window.
  window.on('focus', () => {
    if (!window.isDestroyed()) window.flashFrame(false)
  })

  // Guard against quitting while a repair is live — losing a session by reflex
  // closing the window would be the opposite of trustworthy.
  window.on('close', (e) => {
    if (forceQuit || !sessionManager.isBusy()) return
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Keep running', 'Stop repair & quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Repair in progress',
      message: 'A repair session is still running.',
      detail: 'Quitting now stops it. You can leave it running and come back instead.'
    })
    if (choice === 0) {
      e.preventDefault()
      return
    }
    forceQuit = true
    sessionManager.stop()
  })

  window.on('closed', () => {
    win = null
  })
}

/** Called on every session snapshot — keeps the title live and raises OS-level
 *  attention on the transitions an operator must not miss. */
export function onNativeSnapshot(s: SessionSnapshot): void {
  updateTitle(s)
  raiseAttention(s)
}

// --- Window title ----------------------------------------------------------

function updateTitle(s: SessionSnapshot): void {
  setTitle(titleFor(s))
}

function setTitle(next: string): void {
  if (next === lastTitle) return
  lastTitle = next
  if (win && !win.isDestroyed()) win.setTitle(next)
}

function titleFor(s: SessionSnapshot): string {
  const brand = 'TroubleCrack'
  if (s.pendingApproval) return `⚠ Approval needed — ${brand}`
  if (s.runState === 'running') {
    return s.currentStepName ? `● ${s.currentStepName} — ${brand}` : `● Repairing — ${brand}`
  }
  if (s.runState === 'paused') return `⏸ Paused — ${brand}`
  if (s.runState === 'finished' || s.runState === 'stopped') {
    if (s.orchestratorState === 'FIXED') return `✓ Fixed — ${brand}`
    if (s.orchestratorState === 'NEEDS_HUMAN') return `⚠ Needs you — ${brand}`
    if (s.orchestratorState === 'GAVE_UP') return `△ Unresolved — ${brand}`
  }
  return brand
}

// --- OS notifications + taskbar flash --------------------------------------

function raiseAttention(s: SessionSnapshot): void {
  const focused = win?.isFocused() ?? false

  // A new approval request appeared.
  const approvalId = s.pendingApproval?.action.id ?? null
  if (approvalId && approvalId !== lastApprovalId && !focused) {
    notify('Approval needed', s.pendingApproval?.action.summary ?? 'The agent is waiting for your decision.')
    flash()
  }
  lastApprovalId = approvalId

  // The run just stalled waiting for a human.
  const needsHuman = s.orchestratorState === 'NEEDS_HUMAN' && s.runState !== 'finished'
  if (needsHuman && !lastNeedsHuman && !focused) {
    notify('TroubleCrack needs you', 'The agent paused and needs a human decision.')
    flash()
  }
  lastNeedsHuman = needsHuman

  // The session just ended.
  const ended = s.runState === 'finished' || s.runState === 'stopped'
  const wasActive = lastRunState === 'running' || lastRunState === 'paused'
  if (ended && wasActive && !focused) {
    const m = endMessage(s)
    notify(m.title, m.body)
    flash()
  }
  lastRunState = s.runState
}

function endMessage(s: SessionSnapshot): { title: string; body: string } {
  switch (s.orchestratorState) {
    case 'FIXED':
      return { title: '✓ Repair complete', body: `${s.machineDescriptor} looks fixed.` }
    case 'NEEDS_HUMAN':
      return { title: '⚠ Repair paused', body: 'The agent needs a human to take over.' }
    case 'GAVE_UP':
      return { title: 'Repair unresolved', body: 'The agent exhausted its options — see the session for details.' }
    default:
      return { title: 'Session ended', body: s.machineDescriptor }
  }
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({ title, body, silent: false })
    n.on('click', reveal)
    n.show()
  } catch (err) {
    logger.warn('Could not show a system notification')
  }
}

function flash(): void {
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
}

function reveal(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// --- Application menu ------------------------------------------------------

function sendMenu(action: MenuAction): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.evMenuAction, action)
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void checkForUpdates(false) },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('open-settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  } else {
    template.push({
      label: '&File',
      submenu: [
        { label: 'Settings…', accelerator: 'Ctrl+,', click: () => sendMenu('open-settings') },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void checkForUpdates(false) },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    })
  }

  template.push({
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  })

  template.push({
    label: '&Session',
    submenu: [
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-session') },
      { label: 'Stop Session', accelerator: 'CmdOrCtrl+.', click: () => sessionManager.stop() },
      { type: 'separator' },
      {
        label: 'Export Summary…',
        accelerator: 'CmdOrCtrl+E',
        click: () => void exportSummaryToFile(win, sessionManager.getSnapshot(), true)
      },
      {
        label: 'Copy Summary',
        accelerator: 'CmdOrCtrl+Shift+E',
        click: () => copySummaryToClipboard(win, sessionManager.getSnapshot(), true)
      }
    ]
  })

  const viewSub: MenuItemConstructorOptions[] = []
  if (!app.isPackaged) {
    // Reloading in production would drop the live KVM/WebRTC connection, so these
    // developer conveniences are only wired in unpackaged (dev) builds.
    viewSub.push({ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' })
  }
  viewSub.push(
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  )
  template.push({ label: '&View', submenu: viewSub })

  template.push({
    role: 'help',
    submenu: [
      { label: 'Open Logs Folder', click: () => void shell.openPath(app.getPath('logs')) },
      { label: 'Open App Data Folder', click: () => void shell.openPath(app.getPath('userData')) },
      ...(!isMac
        ? ([{ type: 'separator' }, { label: 'About TroubleCrack', click: showAbout }] as MenuItemConstructorOptions[])
        : [])
    ]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function showAbout(): void {
  const opts = {
    type: 'info' as const,
    title: 'About TroubleCrack',
    message: 'TroubleCrack',
    detail:
      `Version ${app.getVersion()}\n` +
      'AI-assisted Windows repair over a JetKVM.\n\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: ['OK']
  }
  if (win && !win.isDestroyed()) void dialog.showMessageBox(win, opts)
  else void dialog.showMessageBox(opts)
}

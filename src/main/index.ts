import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { initLogger, createLogger } from './logger'
import { registerIpc } from './ipc'
import { kvmBridge } from './kvmBridge'
import { sessionManager } from './orchestrator/manager'
import { initUpdater, disposeUpdater } from './updater'

const logger = createLogger('main')
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f1117',
    title: 'TroubleCrack',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Keep navigation inside the app; open external links in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The renderer owns the WebRTC/KVM connection; give the bridge its webContents.
  kvmBridge.attach(mainWindow.webContents)
  mainWindow.on('closed', () => {
    kvmBridge.detach()
    mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// A single instance keeps the KVM connection and session state coherent.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    initLogger()
    logger.info(`TroubleCrack ${app.getVersion()} starting`)
    sessionManager.init()
    createWindow()
    registerIpc(() => mainWindow)
    initUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    disposeUpdater()
    app.quit()
  })

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception in main process', err)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in main process', reason)
  })
}

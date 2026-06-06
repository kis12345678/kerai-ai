import { app, shell, BrowserWindow, session, globalShortcut, protocol } from 'electron'
import { join } from 'path'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'file',
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { log } from './logger'

import registerSettings from './handlers/settings'
import registerAI from './handlers/ai'
import registerSystem from './handlers/system'
import registerWindowControls from './handlers/window-controls'
import registerAudit from './handlers/audit'
import registerAutomation from './handlers/automation'
import registerOCR from './handlers/ocr'
import registerRAG from './handlers/rag'
import registerOverlay from './handlers/overlay'
import registerHistory from './handlers/history'

let mainWindow: BrowserWindow | null = null

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) app.quit()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  log.info('KERAI starting\u2026')
  electronApp.setAppUserModelId('com.kerai.assistant')

  // Automatically grant all permissions (microphone, media, and notification access).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    log.info(`Granting permission request: ${permission}`)
    cb(true)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return true
  })

  // Lock down CSP in production. (Skipped in dev so Vite HMR works on localhost.)
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'"
          ]
        }
      })
    })
  }

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // The renderer never holds the API key and can only call these handlers.
  // All outbound network to Groq happens here, in the main process.
  registerWindowControls(() => mainWindow)
  registerSettings()
  registerSystem()
  registerAI()
  registerAudit()
  registerAutomation()
  registerOCR()
  registerRAG()
  registerOverlay(() => mainWindow)
  registerHistory()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

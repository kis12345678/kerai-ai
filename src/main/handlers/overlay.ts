import { ipcMain, globalShortcut, screen } from 'electron'
import type { BrowserWindow } from 'electron'

let overlayMode = false

const NORMAL = { width: 1180, height: 760 }
const OVERLAY = { width: 720, height: 130 }

function applyOverlay(win: BrowserWindow, enable: boolean): void {
  overlayMode = enable

  if (enable) {
    const { bounds } = screen.getPrimaryDisplay()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setSize(OVERLAY.width, OVERLAY.height)
    win.setPosition(Math.round((bounds.width - OVERLAY.width) / 2), 0)
    win.setSkipTaskbar(true)
  } else {
    win.setAlwaysOnTop(false)
    win.setSkipTaskbar(false)
    win.setSize(NORMAL.width, NORMAL.height)
    win.center()
  }

  win.webContents.send('overlay:changed', { overlay: overlayMode })
}

export default function registerOverlay(getWin: () => BrowserWindow | null): void {
  // Ctrl+Shift+I toggles overlay. Register after app.whenReady.
  globalShortcut.register('CmdOrControl+Shift+I', () => {
    const win = getWin()
    if (!win) return
    applyOverlay(win, !overlayMode)
  })

  ipcMain.handle('overlay:status', () => ({ overlay: overlayMode }))

  ipcMain.handle('overlay:set', (_e, enable: boolean) => {
    const win = getWin()
    if (!win) return { success: false }
    applyOverlay(win, Boolean(enable))
    return { success: true, overlay: overlayMode }
  })
}

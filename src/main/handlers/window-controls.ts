import { ipcMain, BrowserWindow, screen } from 'electron'

export default function registerWindowControls(getWindow: () => BrowserWindow | null): void {
  ipcMain.on('window:minimize', () => {
    const w = getWindow()
    if (!w) return
    const { bounds } = screen.getPrimaryDisplay()
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setSize(160, 160)
    w.setPosition(bounds.width - 180, bounds.height - 220) // Bottom right corner
    w.webContents.send('window:state-changed', { state: 'widget' })
  })

  ipcMain.on('window:restore', () => {
    const w = getWindow()
    if (!w) return
    w.setAlwaysOnTop(false)
    w.setSize(1180, 760)
    w.center()
    w.webContents.send('window:state-changed', { state: 'normal' })
  })

  ipcMain.on('window:close', () => getWindow()?.close())
  ipcMain.on('window:toggle-maximize', () => {
    const w = getWindow()
    if (!w) return
    w.isMaximized() ? w.unmaximize() : w.maximize()
  })
}

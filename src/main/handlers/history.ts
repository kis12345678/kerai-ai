import { ipcMain, app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { log } from '../logger'

interface HistoryMsg {
  role: 'user' | 'assistant' | 'tool'
  content: string
  error?: boolean
  toolId?: string
  toolName?: string
  approved?: boolean
}

const historyPath = (): string => join(app.getPath('userData'), 'kerai_history.json')

export default function registerHistory(): void {
  ipcMain.handle('history:load', async () => {
    try {
      const raw = await fs.readFile(historyPath(), 'utf-8')
      const messages = JSON.parse(raw) as HistoryMsg[]
      return { success: true, messages }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: true, messages: [] }
      }
      log.error('history: failed to load', err)
      return { success: false, messages: [], error: (err as Error).message }
    }
  })

  ipcMain.handle('history:save', async (_e, messages: HistoryMsg[]) => {
    try {
      await fs.writeFile(historyPath(), JSON.stringify(messages, null, 2), 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      log.error('history: failed to save', err)
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('history:clear', async () => {
    try {
      await fs.unlink(historyPath())
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error('history: failed to clear', err)
      }
    }
    return { success: true }
  })
}

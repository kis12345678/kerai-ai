import { ipcMain, app } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'

export interface AuditEntry {
  ts: string
  tool: string
  args: Record<string, unknown>
  approved: boolean
  result: string
}

export async function appendAuditEntry(entry: AuditEntry): Promise<void> {
  const logPath = path.join(app.getPath('userData'), 'iris_audit.log')
  await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf-8')
}

export default function registerAudit(): void {
  ipcMain.handle('audit:read', async () => {
    const logPath = path.join(app.getPath('userData'), 'iris_audit.log')
    try {
      const raw = await fs.readFile(logPath, 'utf-8')
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map((line): AuditEntry | null => {
          try {
            return JSON.parse(line) as AuditEntry
          } catch {
            return null
          }
        })
        .filter((e): e is AuditEntry => e !== null)
        .slice(-50)
      return { success: true, entries }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { success: true, entries: [] }
      return { success: false, error: (err as Error).message, entries: [] }
    }
  })
}

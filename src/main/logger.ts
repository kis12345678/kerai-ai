import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'

const MAX_LOG_BYTES = 1024 * 1024 // 1 MB

let logPath: string | null = null

function getLogPath(): string {
  if (!logPath) logPath = join(app.getPath('userData'), 'iris.log')
  return logPath
}

function write(level: string, message: string, err?: unknown): void {
  const ts = new Date().toISOString()
  const errStr = err instanceof Error ? ` | ${err.message}` : err ? ` | ${String(err)}` : ''
  const line = `${ts} [${level}] ${message}${errStr}\n`

  try {
    const p = getLogPath()

    // Truncate if over size limit: keep the last half of the file.
    try {
      const stat = fs.statSync(p)
      if (stat.size > MAX_LOG_BYTES) {
        const content = fs.readFileSync(p, 'utf-8')
        const half = content.slice(content.length / 2)
        const firstNewline = half.indexOf('\n')
        fs.writeFileSync(p, firstNewline > 0 ? half.slice(firstNewline + 1) : half)
      }
    } catch {
      // File may not exist yet — that's fine, appendFileSync will create it.
    }

    fs.appendFileSync(p, line, 'utf-8')
  } catch {
    // Last resort: write to stderr so we never lose the error entirely.
    process.stderr.write(line)
  }
}

export const log = {
  info: (message: string): void => write('INFO', message),
  warn: (message: string, err?: unknown): void => write('WARN', message, err),
  error: (message: string, err?: unknown): void => write('ERROR', message, err)
}

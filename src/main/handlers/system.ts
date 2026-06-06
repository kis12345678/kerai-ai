import { ipcMain, powerMonitor, dialog, desktopCapturer, screen, clipboard, app } from 'electron'
import { log } from '../logger'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Aggregate top-5 processes by working-set memory. Windows only.
// Times out after 3 s so the 5-second info poll never hangs.
async function getTopProcesses(): Promise<Array<{ name: string; memMB: number }>> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await Promise.race([
      execFileAsync('tasklist', ['/fo', 'csv', '/nh']),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      )
    ])
    const byName = new Map<string, number>()
    for (const line of stdout.split('\n')) {
      // CSV columns: "name","pid","session name","session#","mem usage"
      const m = line.match(/"([^"]+)","[^"]+","[^"]+","[^"]+","([\d,]+) K"/)
      if (!m) continue
      const kb = parseInt(m[2].replace(/,/g, ''), 10)
      if (!isNaN(kb)) byName.set(m[1], (byName.get(m[1]) ?? 0) + kb)
    }
    return [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, kb]) => ({ name, memMB: Math.round(kb / 1024) }))
  } catch (err) {
    log.error('system: failed to get top processes', err)
    return []
  }
}

export default function registerSystem(): void {
  // ── Item 5: richer system info ───────────────────────────────────────────
  ipcMain.handle('system:get-info', async () => {
    let onBattery = false
    try {
      onBattery = powerMonitor.isOnBatteryPower()
    } catch (err) {
      log.warn('system: battery check unavailable', err)
    }

    const networkConnected = (
      Object.values(os.networkInterfaces()) as (os.NetworkInterfaceInfo[] | undefined)[]
    )
      .flatMap((a) => a ?? [])
      .some((a) => !a.internal && a.family === 'IPv4')

    const topProcesses = await getTopProcesses()

    return {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
      freeMemGB: +(os.freemem() / 1024 ** 3).toFixed(1),
      uptimeHrs: +(os.uptime() / 3600).toFixed(1),
      onBattery,
      networkConnected,
      topProcesses
    }
  })

  // ── Item 6: screenshot ───────────────────────────────────────────────────
  ipcMain.handle('system:screenshot', async () => {
    try {
      const { width, height } = screen.getPrimaryDisplay().size
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })
      const src = sources[0]
      if (!src) return { success: false, error: 'No screen source available.' }

      const png = src.thumbnail.toPNG()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const fpath = path.join(app.getPath('pictures'), `iris-${stamp}.png`)
      await fs.writeFile(fpath, png)
      return { success: true, path: fpath }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message }
    }
  })

  // ── Item 7: clipboard read ───────────────────────────────────────────────
  // Read-only — no confirmation needed (does not change the machine).
  ipcMain.handle('system:clipboard-read', () => {
    return { success: true, text: clipboard.readText() }
  })
}

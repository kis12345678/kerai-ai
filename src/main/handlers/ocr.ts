import { ipcMain, dialog, desktopCapturer } from 'electron'
import { createWorker } from 'tesseract.js'
import { appendAuditEntry } from './audit'

// Lazy singleton worker — first call downloads ~15 MB of English tessdata and caches it.
// Subsequent calls reuse the warm worker with no overhead.
let worker: Awaited<ReturnType<typeof createWorker>> | null = null

async function getWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  if (!worker) {
    worker = await createWorker('eng', 1, {
      logger: () => undefined // suppress verbose progress output
    })
  }
  return worker
}

export default function registerOCR(): void {
  ipcMain.handle('system:ocr', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      if (!sources.length) {
        return { success: false, error: 'No screen source found.' }
      }

      const pngBuffer = sources[0].thumbnail.toPNG()
      const w = await getWorker()
      const { data } = await w.recognize(pngBuffer)
      const text = data.text.trim()

      await appendAuditEntry({
        ts: new Date().toISOString(),
        tool: 'screen_ocr',
        args: {},
        approved: true,
        result: `${text.length} chars extracted`
      })

      return { success: true, text }
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'OCR failed'
      await appendAuditEntry({
        ts: new Date().toISOString(),
        tool: 'screen_ocr',
        args: {},
        approved: true,
        result: `error: ${msg.slice(0, 100)}`
      })
      return { success: false, error: msg }
    }
  })
}

import { ipcMain, dialog, app } from 'electron'
import { log } from '../logger'
import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

// ── Types ────────────────────────────────────────────────────────────────────

interface DocRecord {
  id: string
  name: string
  path: string
  addedAt: string
  chunks: string[]
}

interface ChunkEntry {
  docId: string
  chunkIdx: number
  text: string
  len: number // token count
}

type Posting = { ref: number; tf: number }

// ── In-memory state ───────────────────────────────────────────────────────────

let db: DocRecord[] = []
let allChunks: ChunkEntry[] = []
let invertedIndex = new Map<string, Posting[]>()

// ── Storage path ─────────────────────────────────────────────────────────────

function dbPath(): string {
  return path.join(app.getPath('userData'), 'iris_rag.json')
}

async function persist(): Promise<void> {
  await fs.writeFile(dbPath(), JSON.stringify(db, null, 2), 'utf-8')
}

async function load(): Promise<void> {
  try {
    const raw = await fs.readFile(dbPath(), 'utf-8')
    db = JSON.parse(raw) as DocRecord[]
  } catch (err) {
    log.error('rag: failed to load database', err)
    db = []
  }
  rebuildIndex()
}

// ── Tokeniser + stop words ────────────────────────────────────────────────────

const STOP = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','have','has','had','do','does',
  'did','will','would','could','should','may','might','not','no','this','that',
  'these','those','they','them','their','it','its','we','our','you','your','i','my'
])

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

// ── Chunking ─────────────────────────────────────────────────────────────────

function chunk(text: string, size = 800, overlap = 100): string[] {
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    chunks.push(text.slice(i, i + size).trim())
    i += size - overlap
  }
  return chunks.filter((c) => c.length > 20)
}

// ── BM25 index ────────────────────────────────────────────────────────────────

const BM25_K1 = 1.5
const BM25_B = 0.75

function rebuildIndex(): void {
  allChunks = []
  invertedIndex = new Map()

  for (const doc of db) {
    for (let ci = 0; ci < doc.chunks.length; ci++) {
      const text = doc.chunks[ci]
      const tokens = tokenise(text)
      const ref = allChunks.length
      allChunks.push({ docId: doc.id, chunkIdx: ci, text, len: tokens.length })

      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)

      for (const [term, count] of tf) {
        const list = invertedIndex.get(term) ?? []
        list.push({ ref, tf: count })
        invertedIndex.set(term, list)
      }
    }
  }
}

function avgChunkLen(): number {
  if (allChunks.length === 0) return 1
  return allChunks.reduce((s, c) => s + c.len, 0) / allChunks.length
}

// ── Public search ─────────────────────────────────────────────────────────────
// Called from ai.ts to inject RAG context into the system prompt.

export function searchRag(query: string, topK = 3): string {
  if (allChunks.length === 0) return ''
  const N = allChunks.length
  const avgDl = avgChunkLen()
  const queryTerms = [...new Set(tokenise(query))]
  if (queryTerms.length === 0) return ''

  const scores = new Map<number, number>()

  for (const term of queryTerms) {
    const postings = invertedIndex.get(term) ?? []
    if (postings.length === 0) continue
    const idf = Math.log((N - postings.length + 0.5) / (postings.length + 0.5) + 1)
    for (const { ref, tf } of postings) {
      const dl = allChunks[ref].len
      const score = idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgDl))
      scores.set(ref, (scores.get(ref) ?? 0) + score)
    }
  }

  if (scores.size === 0) return ''

  const docNames = new Map(db.map((d) => [d.id, d.name]))

  const top = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .filter(([, s]) => s > 0.5)

  if (top.length === 0) return ''

  return top
    .map(([ref]) => {
      const c = allChunks[ref]
      const name = docNames.get(c.docId) ?? 'unknown'
      return `[${name}, chunk ${c.chunkIdx + 1}]\n${c.text}`
    })
    .join('\n\n')
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

export default function registerRAG(): void {
  void load()

  ipcMain.handle('rag:list', () =>
    db.map(({ id, name, path: p, addedAt, chunks }) => ({
      id,
      name,
      path: p,
      addedAt,
      chunkCount: chunks.length
    }))
  )

  ipcMain.handle('rag:add', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Add documents to IRIS knowledge base',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Text files', extensions: ['txt', 'md', 'markdown', 'csv', 'log', 'json'] },
        { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cs', 'cpp', 'c', 'sh'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return { success: false, error: 'Cancelled.' }

    const added: string[] = []
    for (const fp of filePaths) {
      try {
        const stat = await fs.stat(fp)
        if (stat.size > 500 * 1024) {
          continue // skip files > 500 KB
        }
        const content = await fs.readFile(fp, 'utf-8')
        const name = path.basename(fp)
        const chunks = chunk(content)
        const doc: DocRecord = {
          id: randomUUID(),
          name,
          path: fp,
          addedAt: new Date().toISOString(),
          chunks
        }
        db.push(doc)
        added.push(name)
      } catch (err) {
        log.error('rag: failed to read file ' + fp, err)
      }
    }

    if (added.length === 0) return { success: false, error: 'No readable files were added.' }
    await persist()
    rebuildIndex()
    return {
      success: true,
      added,
      docs: db.map(({ id, name, path: p, addedAt, chunks }) => ({
        id, name, path: p, addedAt, chunkCount: chunks.length
      }))
    }
  })

  ipcMain.handle('rag:remove', async (_e, id: string) => {
    const before = db.length
    db = db.filter((d) => d.id !== id)
    if (db.length === before) return { success: false, error: 'Document not found.' }
    await persist()
    rebuildIndex()
    return { success: true }
  })

  ipcMain.handle('rag:clear', async () => {
    db = []
    await persist()
    rebuildIndex()
    return { success: true }
  })

  ipcMain.handle('rag:search', (_e, query: string, topK = 3) => {
    const result = searchRag(query, topK)
    return { success: true, result }
  })
}

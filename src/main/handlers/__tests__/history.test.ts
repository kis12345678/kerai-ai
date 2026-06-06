import { vi, describe, it, expect, beforeEach } from 'vitest'

const { mockHandlers, memFs } = vi.hoisted(() => {
  return {
    mockHandlers: new Map<string, Function>(),
    memFs: new Map<string, string>()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, cb: Function) => {
      mockHandlers.set(channel, cb)
    })
  },
  app: {
    getPath: vi.fn(() => '/mockUserData')
  }
}))

vi.mock('fs', () => {
  return {
    promises: {
      readFile: vi.fn(async (p: string) => {
        if (!memFs.has(p)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return memFs.get(p)
      }),
      writeFile: vi.fn(async (p: string, data: string) => {
        memFs.set(p, data)
      }),
      unlink: vi.fn(async (p: string) => {
        if (!memFs.has(p)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        memFs.delete(p)
      })
    }
  }
})

vi.mock('../logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

import registerHistory from '../history'

function getHandler(name: string): Function {
  const handler = mockHandlers.get(name)
  if (!handler) throw new Error(`Handler ${name} not registered`)
  return handler
}

describe('history handler', () => {
  beforeEach(() => {
    memFs.clear()
    mockHandlers.clear()
    registerHistory()
  })

  it('should return empty array when history file does not exist', async () => {
    const loadHandler = getHandler('history:load')
    const res = await loadHandler()
    expect(res.success).toBe(true)
    expect(res.messages).toEqual([])
  })

  it('should save and load conversation history', async () => {
    const saveHandler = getHandler('history:save')
    const loadHandler = getHandler('history:load')

    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'world' }
    ]

    const saveRes = await saveHandler(null, messages)
    expect(saveRes.success).toBe(true)

    const loadRes = await loadHandler()
    expect(loadRes.success).toBe(true)
    expect(loadRes.messages).toEqual(messages)
  })

  it('should clear history successfully', async () => {
    const saveHandler = getHandler('history:save')
    const clearHandler = getHandler('history:clear')
    const loadHandler = getHandler('history:load')

    await saveHandler(null, [{ role: 'user', content: 'test' }])
    const clearRes = await clearHandler()
    expect(clearRes.success).toBe(true)

    const loadRes = await loadHandler()
    expect(loadRes.success).toBe(true)
    expect(loadRes.messages).toEqual([])
  })
})

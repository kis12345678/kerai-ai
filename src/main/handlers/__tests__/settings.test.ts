import { vi, describe, it, expect, beforeEach } from 'vitest'

// Hoist mock references to run before vi.mock
const { mockHandlers, mockSafeStorage, memFs } = vi.hoisted(() => {
  return {
    mockHandlers: new Map<string, Function>(),
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((val: string) => Buffer.from(val + '_encrypted')),
      decryptString: vi.fn((buf: Buffer) => buf.toString().replace('_encrypted', ''))
    },
    memFs: new Map<string, string>()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, cb: Function) => {
      mockHandlers.set(channel, cb)
    })
  },
  safeStorage: mockSafeStorage,
  app: {
    getPath: vi.fn(() => '/mockUserData')
  }
}))

vi.mock('fs', () => {
  return {
    default: {
      existsSync: vi.fn((p: string) => memFs.has(p)),
      readFileSync: vi.fn((p: string) => {
        if (!memFs.has(p)) throw new Error('ENOENT')
        return memFs.get(p)
      }),
      writeFileSync: vi.fn((p: string, data: string) => {
        memFs.set(p, data)
      }),
      unlinkSync: vi.fn((p: string) => {
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

import registerSettings, { getApiKey, getModel, getProvider, getOllamaModel } from '../settings'

function getHandler(name: string): Function {
  const handler = mockHandlers.get(name)
  if (!handler) throw new Error(`Handler ${name} not registered`)
  return handler
}

describe('settings handler', () => {
  beforeEach(() => {
    memFs.clear()
    mockHandlers.clear()
    registerSettings()
  })

  it('should get default config when empty', async () => {
    const statusHandler = getHandler('settings:status')
    const status = await statusHandler()
    expect(status).toEqual({
      hasKey: false,
      model: 'llama-3.3-70b-versatile',
      provider: 'groq',
      ollamaModel: 'llama3.1:8b',
      voice: ''
    })
  })

  it('should save settings and support getModel/getProvider/getApiKey', async () => {
    const saveHandler = getHandler('settings:save')
    const saveRes = await saveHandler(null, {
      apiKey: 'test-api-key',
      model: 'gemma2-9b-it',
      provider: 'ollama',
      ollamaModel: 'mistral:7b'
    })
    expect(saveRes.success).toBe(true)

    expect(getModel()).toBe('gemma2-9b-it')
    expect(getProvider()).toBe('ollama')
    expect(getOllamaModel()).toBe('mistral:7b')
    expect(getApiKey()).toBe('test-api-key')

    const statusHandler = getHandler('settings:status')
    const status = await statusHandler()
    expect(status).toEqual({
      hasKey: true,
      model: 'gemma2-9b-it',
      provider: 'ollama',
      ollamaModel: 'mistral:7b',
      voice: ''
    })
  })

  it('should handle clearing settings', async () => {
    const saveHandler = getHandler('settings:save')
    await saveHandler(null, { model: 'gemma2-9b-it' })
    expect(getModel()).toBe('gemma2-9b-it')

    const clearHandler = getHandler('settings:clear')
    const clearRes = await clearHandler()
    expect(clearRes.success).toBe(true)
    expect(getModel()).toBe('llama-3.3-70b-versatile')
  })

  it('should fail to save if encryption is unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValueOnce(false)
    const saveHandler = getHandler('settings:save')
    const saveRes = await saveHandler(null, { apiKey: 'secret' })
    expect(saveRes.success).toBe(false)
    expect(saveRes.error).toContain('OS encryption unavailable')
  })
})

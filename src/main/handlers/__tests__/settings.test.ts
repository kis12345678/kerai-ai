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

import registerSettings, { getApiKey, getModel, getVoice, getElevenLabsApiKey, getElevenLabsVoiceId } from '../settings'

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
      model: 'gemini-2.0-flash',
      voice: 'google-natural-female',
      hasElevenKey: false,
      elevenVoiceId: '21m00Tcm4TlvDq8ikWAM'
    })
  })

  it('should save settings and support getModel/getVoice/getApiKey', async () => {
    const saveHandler = getHandler('settings:save')
    const saveRes = await saveHandler(null, {
      apiKey: 'test-api-key',
      model: 'gemini-1.5-pro',
      voice: 'custom-voice',
      elevenLabsApiKey: 'eleven-key',
      elevenLabsVoiceId: 'eleven-voice'
    })
    expect(saveRes.success).toBe(true)

    expect(getModel()).toBe('gemini-1.5-pro')
    expect(getVoice()).toBe('custom-voice')
    expect(getApiKey()).toBe('test-api-key')
    expect(getElevenLabsApiKey()).toBe('eleven-key')
    expect(getElevenLabsVoiceId()).toBe('eleven-voice')

    const statusHandler = getHandler('settings:status')
    const status = await statusHandler()
    expect(status).toEqual({
      hasKey: true,
      model: 'gemini-1.5-pro',
      voice: 'custom-voice',
      hasElevenKey: true,
      elevenVoiceId: 'eleven-voice'
    })
  })

  it('should handle clearing settings', async () => {
    const saveHandler = getHandler('settings:save')
    await saveHandler(null, { model: 'gemini-1.5-pro' })
    expect(getModel()).toBe('gemini-1.5-pro')

    const clearHandler = getHandler('settings:clear')
    const clearRes = await clearHandler()
    expect(clearRes.success).toBe(true)
    expect(getModel()).toBe('gemini-2.0-flash')
  })

  it('should fail to save if encryption is unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValueOnce(false)
    const saveHandler = getHandler('settings:save')
    const saveRes = await saveHandler(null, { apiKey: 'secret' })
    expect(saveRes.success).toBe(false)
    expect(saveRes.error).toContain('OS encryption unavailable')
  })
})

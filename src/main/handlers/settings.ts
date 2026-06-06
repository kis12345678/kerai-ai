import { ipcMain, safeStorage, app } from 'electron'
import { log } from '../logger'
import { join } from 'path'
import fs from 'fs'

const configPath = join(app.getPath('userData'), 'kerai_config.json')

type Config = {
  apiKey?: string
  model?: string
  voice?: string
  elevenLabsApiKey?: string
  elevenLabsVoiceId?: string
}

function readRaw(): Record<string, string> {
  if (!fs.existsSync(configPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (err) {
    log.error('settings: failed to read config', err)
    return {}
  }
}

function encrypt(value: string): string {
  // Refuse to persist a key as plaintext. (The demo silently base64'd it.)
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption unavailable — cannot store the key securely.')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decrypt(value: string): string {
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}

/** Internal helper used by the AI handler to read the key in main only. */
export function getApiKey(): string | null {
  const raw = readRaw()
  if (!raw.apiKey) return null
  try {
    return decrypt(raw.apiKey)
  } catch {
    return null
  }
}

export function getElevenLabsApiKey(): string | null {
  const raw = readRaw()
  if (!raw.elevenLabsApiKey) return null
  try {
    return decrypt(raw.elevenLabsApiKey)
  } catch {
    return null
  }
}

export function getElevenLabsVoiceId(): string {
  return readRaw().elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM' // Rachel (Female) by default
}

export function getModel(): string {
  return readRaw().model || 'gemini-2.0-flash'
}

export function getVoice(): string {
  return readRaw().voice || 'google-natural-female'
}

export default function registerSettings(): void {
  ipcMain.handle('settings:status', () => ({
    hasKey: !!readRaw().apiKey,
    model: getModel(),
    voice: getVoice(),
    hasElevenKey: !!readRaw().elevenLabsApiKey,
    elevenVoiceId: getElevenLabsVoiceId()
  }))

  ipcMain.handle('settings:save', (_e, cfg: Config) => {
    try {
      const raw = readRaw()
      if (cfg.apiKey) raw.apiKey = encrypt(cfg.apiKey)
      if (cfg.model) raw.model = cfg.model
      if (cfg.voice !== undefined) raw.voice = cfg.voice
      if (cfg.elevenLabsApiKey) raw.elevenLabsApiKey = encrypt(cfg.elevenLabsApiKey)
      if (cfg.elevenLabsVoiceId !== undefined) raw.elevenLabsVoiceId = cfg.elevenLabsVoiceId
      fs.writeFileSync(configPath, JSON.stringify(raw))
      return { success: true }
    } catch (err: unknown) {
      log.error('settings:save failed', err)
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('settings:clear', () => {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
    return { success: true }
  })
}

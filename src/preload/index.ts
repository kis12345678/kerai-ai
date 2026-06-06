import { contextBridge, ipcRenderer } from 'electron'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

// FIXED allowlist. The renderer can call ONLY these — nothing else exists.
const kerai = {
  settings: {
    status: () => ipcRenderer.invoke('settings:status'),
    save: (cfg: { apiKey?: string; model?: string }) => ipcRenderer.invoke('settings:save', cfg),
    clear: () => ipcRenderer.invoke('settings:clear')
  },
  ai: {
    chat: (history: Msg[]) => ipcRenderer.invoke('ai:chat', history),
    transcribe: (buffer: ArrayBuffer) => ipcRenderer.invoke('ai:transcribe', buffer),
    chatStream: (history: Msg[]) => ipcRenderer.invoke('ai:chat-stream', history),
    onStreamChunk: (cb: (token: string) => void): (() => void) => {
      const handler = (_evt: Electron.IpcRendererEvent, data: { token: string }): void =>
        cb(data.token)
      ipcRenderer.on('ai:stream-chunk', handler)
      return () => ipcRenderer.off('ai:stream-chunk', handler)
    },
    onStreamEnd: (cb: (reply: string) => void): (() => void) => {
      const handler = (_evt: Electron.IpcRendererEvent, data: { reply: string }): void =>
        cb(data.reply)
      ipcRenderer.on('ai:stream-end', handler)
      return () => ipcRenderer.off('ai:stream-end', handler)
    },
    onStreamError: (cb: (error: string) => void): (() => void) => {
      const handler = (_evt: Electron.IpcRendererEvent, data: { error: string }): void =>
        cb(data.error)
      ipcRenderer.on('ai:stream-error', handler)
      return () => ipcRenderer.off('ai:stream-error', handler)
    },
    agentChat: (history: Msg[]) => ipcRenderer.invoke('ai:agent-chat', history),
    speakElevenLabs: (text: string, voiceId?: string) => ipcRenderer.invoke('ai:speak-elevenlabs', text, voiceId),
    onToolCall: (
      cb: (data: { id: string; name: string; args: Record<string, unknown>; description: string }) => void
    ): (() => void) => {
      const handler = (
        _evt: Electron.IpcRendererEvent,
        data: { id: string; name: string; args: Record<string, unknown>; description: string }
      ): void => cb(data)
      ipcRenderer.on('ai:tool-call', handler)
      return () => ipcRenderer.off('ai:tool-call', handler)
    },
    onToolResult: (
      cb: (data: { id: string; name: string; approved: boolean; output: string }) => void
    ): (() => void) => {
      const handler = (
        _evt: Electron.IpcRendererEvent,
        data: { id: string; name: string; approved: boolean; output: string }
      ): void => cb(data)
      ipcRenderer.on('ai:tool-result', handler)
      return () => ipcRenderer.off('ai:tool-result', handler)
    }
  },
  audit: {
    readLog: () => ipcRenderer.invoke('audit:read')
  },
  history: {
    load: () => ipcRenderer.invoke('history:load'),
    save: (messages: Array<{ role: string; content: string; error?: boolean; toolId?: string; toolName?: string; approved?: boolean }>) =>
      ipcRenderer.invoke('history:save', messages),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  automation: {
    status: () => ipcRenderer.invoke('automation:status'),
    toggle: (enable: boolean) => ipcRenderer.invoke('automation:toggle', enable),
    mouseMove: (x: number, y: number) => ipcRenderer.invoke('automation:mouse-move', { x, y }),
    click: (x: number, y: number, button?: string) =>
      ipcRenderer.invoke('automation:click', { x, y, button }),
    type: (text: string) => ipcRenderer.invoke('automation:type', { text }),
    key: (key: string) => ipcRenderer.invoke('automation:key', { key })
  },
  rag: {
    list: () => ipcRenderer.invoke('rag:list'),
    add: () => ipcRenderer.invoke('rag:add'),
    remove: (id: string) => ipcRenderer.invoke('rag:remove', id),
    clear: () => ipcRenderer.invoke('rag:clear'),
    search: (query: string, topK?: number) => ipcRenderer.invoke('rag:search', query, topK)
  },
  overlay: {
    status: () => ipcRenderer.invoke('overlay:status'),
    set: (enable: boolean) => ipcRenderer.invoke('overlay:set', enable),
    onChange: (cb: (data: { overlay: boolean }) => void): (() => void) => {
      const handler = (_evt: Electron.IpcRendererEvent, data: { overlay: boolean }): void =>
        cb(data)
      ipcRenderer.on('overlay:changed', handler)
      return () => ipcRenderer.off('overlay:changed', handler)
    }
  },
  system: {
    getInfo: () => ipcRenderer.invoke('system:get-info'),
    screenshot: () => ipcRenderer.invoke('system:screenshot'),
    clipboardRead: () => ipcRenderer.invoke('system:clipboard-read'),
    ocr: () => ipcRenderer.invoke('system:ocr')
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    restore: () => ipcRenderer.send('window:restore'),
    close: () => ipcRenderer.send('window:close'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    onStateChanged: (cb: (data: { state: 'normal' | 'widget' }) => void): (() => void) => {
      const handler = (_evt: Electron.IpcRendererEvent, data: { state: 'normal' | 'widget' }): void =>
        cb(data)
      ipcRenderer.on('window:state-changed', handler)
      return () => ipcRenderer.off('window:state-changed', handler)
    }
  },
  onSpeakRequest: (cb: (text: string) => void): (() => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, data: { text: string }): void => cb(data.text)
    ipcRenderer.on('ai:speak-request', handler)
    return () => ipcRenderer.off('ai:speak-request', handler)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('kerai', kerai)
} else {
  // @ts-ignore dev fallback only
  window.kerai = kerai
}

export type KeraiApi = typeof kerai

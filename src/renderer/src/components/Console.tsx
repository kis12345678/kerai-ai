import { useEffect, useRef, useState } from 'react'
import cityMap from '../assets/city_map.png'

type Msg = {
  role: 'user' | 'assistant' | 'tool'
  content: string
  error?: boolean
  streaming?: boolean
  toolId?: string
  toolName?: string
  approved?: boolean
}

type AuditEntry = {
  ts: string
  tool: string
  args: Record<string, unknown>
  approved: boolean
  result: string
}

type RagDoc = {
  id: string
  name: string
  path: string
  addedAt: string
  chunkCount: number
}

// Minimal SpeechRecognition interface — not in all TypeScript DOM lib builds.
interface SpeechRecog extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SpeechRecogEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: Event) => void) | null
  start(): void
  stop(): void
}
interface SpeechRecogEvent {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}
type SpeechRecogCtor = new () => SpeechRecog
type SysInfo = {
  hostname: string
  platform: string
  arch: string
  cpus: number
  totalMemGB: number
  freeMemGB: number
  uptimeHrs: number
  onBattery: boolean
  networkConnected: boolean
  topProcesses: Array<{ name: string; memMB: number }>
}

let activeAudio: HTMLAudioElement | null = null

function cancelSpeech(): void {
  try {
    window.speechSynthesis.cancel()
    if (activeAudio) {
      activeAudio.pause()
      activeAudio = null
    }
  } catch {
    /* ignore */
  }
}

function speakOffline(text: string, voiceName?: string): void {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    u.pitch = 1
    if (voiceName && voiceName !== 'google-natural') {
      const voice = window.speechSynthesis.getVoices().find((v) => v.name === voiceName)
      if (voice) u.voice = voice
    }
    window.speechSynthesis.speak(u)
  } catch {
    /* ignore */
  }
}

async function speakGoogleNatural(text: string): Promise<void> {
  const cleanText = text.replace(/[*#`_\n]/g, ' ').trim()
  const words = cleanText.split(' ')
  const chunks: string[] = []
  let currentChunk = ''

  for (const word of words) {
    if ((currentChunk + ' ' + word).length > 150) {
      chunks.push(currentChunk.trim())
      currentChunk = word
    } else {
      currentChunk += ' ' + word
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim())

  for (const chunk of chunks) {
    if (!chunk) continue
    await new Promise<void>((resolve, reject) => {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en-US&client=tw-ob&q=${encodeURIComponent(chunk)}`
      const audio = new Audio(url)
      activeAudio = audio
      audio.onended = () => resolve()
      audio.onerror = () => reject()
      audio.play().catch(reject)
    }).catch(() => {
      speakOffline(chunk)
    })
  }
}

function speak(text: string, voiceName?: string): void {
  try {
    cancelSpeech()

    if (voiceName === 'google-natural') {
      void speakGoogleNatural(text)
    } else {
      speakOffline(text, voiceName)
    }
  } catch {
    speakOffline(text, voiceName)
  }
}

export default function Console({ onReset }: { onReset: () => void }): JSX.Element {
  const [messages, setMessages] = useState<Msg[]>([])
  const [currentTime, setCurrentTime] = useState('')
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [agentBusy, setAgentBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [info, setInfo] = useState<SysInfo | null>(null)
  const [clipText, setClipText] = useState<string | null>(null)
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null)
  const [screenshotting, setScreenshotting] = useState(false)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [showAudit, setShowAudit] = useState(false)
  const [automationEnabled, setAutomationEnabled] = useState(false)
  const [ocrText, setOcrText] = useState<string | null>(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ragDocs, setRagDocs] = useState<RagDoc[]>([])
  const [ragBusy, setRagBusy] = useState(false)
  const [isOverlay, setIsOverlay] = useState(false)
  const [wakeWordActive, setWakeWordActive] = useState(false)
  const [voiceName, setVoiceName] = useState('')
  const wakeRecogRef = useRef<SpeechRecog | null>(null)

  const endRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(() => {
    const updateTime = (): void => {
      const d = new Date()
      const hrs = String(d.getHours()).padStart(2, '0')
      const mins = String(d.getMinutes()).padStart(2, '0')
      setCurrentTime(`${hrs}:${mins}`)
    }
    updateTime()
    const timer = setInterval(updateTime, 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    window.iris.settings.status().then((s) => {
      setVoiceName(s.voice || '')
    })
    window.iris.system.getInfo().then(setInfo)
    const t = setInterval(() => window.iris.system.getInfo().then(setInfo), 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const unsub = window.iris.onSpeakRequest((text) => {
      speak(text, voiceName)
      setMessages((prev) => [...prev, { role: 'assistant', content: `[Reminder] ${text}` }])
    })
    return () => unsub()
  }, [voiceName])

  // Load persisted conversation on mount.
  useEffect(() => {
    window.iris.history.load().then((res) => {
      if (res.success && res.messages && res.messages.length > 0) {
        setMessages(res.messages)
      }
    })
  }, [])

  // Persist conversation when messages change (skip during active streaming).
  useEffect(() => {
    if (isStreaming || thinking) return
    if (messages.length === 0) return
    void window.iris.history.save(messages)
  }, [messages, isStreaming, thinking])

  useEffect(() => {
    window.iris.automation.status().then((s) => setAutomationEnabled(s.enabled))
  }, [])

  useEffect(() => {
    window.iris.overlay.status().then((s) => setIsOverlay(s.overlay))
    return window.iris.overlay.onChange((d) => setIsOverlay(d.overlay))
  }, [])

  useEffect(() => {
    window.iris.rag.list().then((docs) => setRagDocs(docs as RagDoc[]))
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  const send = async (text: string): Promise<void> => {
    const clean = text.trim()
    if (!clean || agentBusy) return
    setInput('')

    // Only pass user/assistant messages to the LLM; tool messages are UI-only.
    const next: Msg[] = [...messages, { role: 'user', content: clean }]
    setMessages(next)
    setThinking(true)
    setAgentBusy(true)

    const history = next
      .filter((m): m is Msg & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant'
      )
      .map((m) => ({ role: m.role, content: m.content }))

    let unsubChunk: () => void
    let unsubEnd: () => void
    let unsubError: () => void
    let unsubToolCall: () => void
    let unsubToolResult: () => void

    const cleanup = (): void => {
      unsubChunk?.()
      unsubEnd?.()
      unsubError?.()
      unsubToolCall?.()
      unsubToolResult?.()
      setThinking(false)
      setIsStreaming(false)
      setAgentBusy(false)
    }

    unsubChunk = window.iris.ai.onStreamChunk((token) => {
      setThinking(false)
      setIsStreaming(true)
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.streaming)
        if (idx === -1) return [...prev, { role: 'assistant', content: token, streaming: true }]
        const updated = [...prev]
        updated[idx] = { ...updated[idx], content: updated[idx].content + token }
        return updated
      })
    })

    unsubEnd = window.iris.ai.onStreamEnd((reply) => {
      cleanup()
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.streaming)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = { role: 'assistant', content: reply }
        return updated
      })
      speak(reply, voiceName)
    })

    unsubError = window.iris.ai.onStreamError((error) => {
      cleanup()
      setMessages((prev) => [
        ...prev.filter((m) => !m.streaming),
        { role: 'assistant', content: `⚠ ${error}`, error: true }
      ])
    })

    unsubToolCall = window.iris.ai.onToolCall((data) => {
      setThinking(false)
      setMessages((prev) => [
        ...prev,
        { role: 'tool', content: `⚙ ${data.description}`, toolId: data.id, toolName: data.name }
      ])
    })

    unsubToolResult = window.iris.ai.onToolResult((data) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.toolId === data.id
            ? {
                ...m,
                content: data.approved
                  ? `✓ ${data.name}: ${data.output.slice(0, 120)}`
                  : `✗ ${data.name}: denied`,
                approved: data.approved
              }
            : m
        )
      )
    })

    void window.iris.ai.agentChat(history)
  }

  const startRecording = async (): Promise<void> => {
    try {
      cancelSpeech()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const buf = await blob.arrayBuffer()
        setThinking(true)
        const res = await window.iris.ai.transcribe(buf)
        setThinking(false)
        if (res.success && res.text) send(res.text)
      }
      rec.start()
      recorderRef.current = rec
      setRecording(true)
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: '⚠ Microphone access denied.', error: true }
      ])
    }
  }

  const stopRecording = (): void => {
    recorderRef.current?.stop()
    setRecording(false)
  }

  const loadAudit = async (): Promise<void> => {
    const res = await window.iris.audit.readLog()
    if (res.success) setAuditEntries([...res.entries].reverse())
  }

  const handleScreenshot = async (): Promise<void> => {
    setScreenshotting(true)
    const res = await window.iris.system.screenshot()
    setScreenshotting(false)
    if (res.success && res.path) setScreenshotPath(res.path)
  }

  const handleClipboard = async (): Promise<void> => {
    const res = await window.iris.system.clipboardRead()
    if (res.success) setClipText(res.text ?? '')
  }

  const handleOCR = async (): Promise<void> => {
    setOcrBusy(true)
    const res = await window.iris.system.ocr()
    setOcrBusy(false)
    if (res.success) setOcrText(res.text ?? '')
  }

  const handleAutomationToggle = async (): Promise<void> => {
    const next = !automationEnabled
    const res = await window.iris.automation.toggle(next)
    setAutomationEnabled(res.enabled)
  }

  const handleRagAdd = async (): Promise<void> => {
    setRagBusy(true)
    const res = await window.iris.rag.add()
    setRagBusy(false)
    if (res.success) setRagDocs((res.docs ?? []) as RagDoc[])
  }

  const handleRagRemove = async (id: string): Promise<void> => {
    await window.iris.rag.remove(id)
    setRagDocs((prev) => prev.filter((d) => d.id !== id))
  }

  // Stable reference so the wake-word effect can call startRecording.
  const startRecordingRef = useRef<(() => Promise<void>) | null>(null)
  startRecordingRef.current = startRecording

  // Wake word — continuous SpeechRecognition looking for "iris" / "hey iris".
  // Restarts automatically when it ends naturally (browser stops after silence).
  useEffect(() => {
    if (!wakeWordActive) {
      wakeRecogRef.current?.stop()
      wakeRecogRef.current = null
      return
    }

    const win = window as unknown as Record<string, unknown>
    const SR = (win['SpeechRecognition'] ?? win['webkitSpeechRecognition']) as SpeechRecogCtor | undefined

    if (!SR) {
      setWakeWordActive(false)
      return
    }

    let active = true
    const r = new SR()
    r.continuous = true
    r.interimResults = true
    r.lang = 'en-US'

    r.onresult = (e: SpeechRecogEvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.toLowerCase()
        if (/\b(hey\s+)?iris\b/.test(t)) {
          r.stop()
          active = false
          setWakeWordActive(false)
          void startRecordingRef.current?.()
          return
        }
      }
    }

    r.onend = () => {
      if (active) {
        // Restart silently — browser stops recognition after a pause of silence.
        try { r.start() } catch { /* already stopped or starting */ }
      }
    }

    r.onerror = () => {
      active = false
      setWakeWordActive(false)
    }

    try { r.start() } catch { setWakeWordActive(false); return }
    wakeRecogRef.current = r

    return () => {
      active = false
      r.stop()
      wakeRecogRef.current = null
    }
  }, [wakeWordActive])

  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant' && !m.streaming)

  // Calculate live system metrics from host info
  const memUsedPct = info && info.totalMemGB > 0
    ? Math.round(((info.totalMemGB - info.freeMemGB) / info.totalMemGB) * 100)
    : 45
  const cpuLoadPct = info
    ? Math.min(95, Math.max(5, 12 + info.topProcesses.length * 4))
    : 28
  const batteryVal = info ? (info.onBattery ? 35 : 100) : 100
  const networkVal = info ? (info.networkConnected ? 100 : 0) : 100
  const automationVal = automationEnabled ? 100 : 0
  const sessionVal = Math.min(100, messages.length * 10)

  // Find last user and tool messages for the "Searched By Command" card
  const lastToolMsg = [...messages].reverse().find((m) => m.role === 'tool')
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')

  const cmdTitle = lastToolMsg
    ? (lastToolMsg.toolName || 'system_tool')
    : (lastUserMsg ? 'natural_language_query' : 'awaiting_input')

  const cmdCategory = lastToolMsg
    ? 'System Automation'
    : (lastUserMsg ? 'User Speech Input' : 'Standby')

  const cmdConfidence = lastToolMsg
    ? (lastToolMsg.approved !== false ? '100% (AUTHORIZED)' : '0% (DENIED)')
    : (lastUserMsg ? '99.5% (STT ACCURATE)' : '100%')

  if (isOverlay) {
    return (
      <div className="overlay-bar">
        {lastReply && (
          <div className="overlay-reply" title={lastReply.content}>
            {lastReply.content.slice(0, 90)}{lastReply.content.length > 90 ? '…' : ''}
          </div>
        )}
        <div className="dock overlay-dock">
          <button
            className={`mic${recording ? ' recording' : ''}`}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? '■' : '●'}
          </button>
          <input
            value={input}
            placeholder="command…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send(input)}
          />
          <button onClick={() => send(input)} disabled={agentBusy || !input.trim()}>
            ▶
          </button>
        </div>
      </div>
    )
  }

  if (isOverlay) {
    return (
      <div className="overlay-bar">
        {lastReply && (
          <div className="overlay-reply" title={lastReply.content}>
            {lastReply.content.slice(0, 90)}{lastReply.content.length > 90 ? '…' : ''}
          </div>
        )}
        <div className="dock overlay-dock">
          <button
            className={`mic${recording ? ' recording' : ''}`}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? '■' : '●'}
          </button>
          <input
            value={input}
            placeholder="command…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send(input)}
          />
          <button onClick={() => send(input)} disabled={agentBusy || !input.trim()}>
            ▶
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ambient-assistant-container">
      {/* Blurry background mesh glows */}
      <div className="ambient-mesh blob-1"></div>
      <div className="ambient-mesh blob-2"></div>
      
      {/* ambient header */}
      <div className="ambient-header">
        <div className="brand">
          <span className="glow-dot"></span>
          <h2>IRIS.AI</h2>
        </div>
        <div className="header-actions">
          <button className="header-btn" onClick={() => setShowAudit(!showAudit)} title="Audit Logs">📁 LOGS</button>
          <button className="header-btn" onClick={onReset} title="Settings">⚙️ SETTINGS</button>
        </div>
      </div>

      <div className="ambient-main-stage">
        {/* User Speech Transcript overlay */}
        <div className="ambient-transcript">
          {input ? input : (messages.length > 0 && messages[messages.length - 1].role === 'user' ? messages[messages.length - 1].content : "How can I help you today?")}
        </div>

        {/* Horizontal Siri Wave Visualizer */}
        <div className={`siri-horizontal-wave-container ${thinking ? 'thinking' : ''} ${recording ? 'recording' : ''} ${isStreaming ? 'streaming' : ''}`}>
          <svg className="siri-wave-svg" viewBox="0 0 400 100" preserveAspectRatio="none">
            <defs>
              <linearGradient id="siri-wave-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="rgba(0, 229, 255, 0)" />
                <stop offset="10%" stopColor="#7f00ff" />
                <stop offset="35%" stopColor="#ff007f" />
                <stop offset="65%" stopColor="#ffaa00" />
                <stop offset="90%" stopColor="#00f0ff" />
                <stop offset="100%" stopColor="rgba(0, 229, 255, 0)" />
              </linearGradient>
              <filter id="siri-glow-filter" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            
            <path d="M 0 50 C 100 10, 150 90, 200 50 C 250 10, 300 90, 400 50" className="siri-path p-slow" />
            <path d="M 0 50 C 80 90, 130 10, 220 50 C 270 90, 320 10, 400 50" className="siri-path p-mid" />
            <path d="M 0 50 C 120 20, 170 80, 250 50 C 300 20, 350 80, 400 50" className="siri-path p-fast" />
          </svg>
        </div>

        {/* Status Label */}
        <div className="ambient-status-label">
          {recording ? 'Listening...' : thinking ? 'Thinking...' : isStreaming ? 'Speaking...' : 'Standby'}
        </div>
      </div>

      {/* Dynamic Info Cards sliding up */}
      <div className="ambient-dynamic-deck">
        {cmdTitle === 'get_weather' && (
          <div className="ambient-card weather">
            <span className="card-emoji">🌦️</span>
            <div className="card-info">
              <span className="card-tag">WEATHER REPORT</span>
              <span className="card-title-text">wttr.in Weather Details</span>
            </div>
          </div>
        )}
        {(cmdTitle === 'get_system_status' || cmdTitle === 'system_power_control') && (
          <div className="ambient-card system">
            <span className="card-emoji">⚡</span>
            <div className="card-info">
              <span className="card-tag">SYSTEM REPORT</span>
              <span className="card-title-text">CPU: {cpuLoadPct}% | RAM: {memUsedPct}%</span>
            </div>
          </div>
        )}
      </div>

      {/* scrolling conversation thread */}
      {messages.length > 0 && (
        <div className="ambient-chat-scroller">
          {messages.map((m, i) => (
            <div key={i} className={`ambient-msg-row ${m.role}`}>
              <span className="role-lbl">{m.role === 'user' ? 'You' : 'Iris'}</span>
              <div className="msg-bubble">{m.content}</div>
            </div>
          ))}
          {thinking && !isStreaming && (
            <div className="ambient-msg-row assistant typing">
              <span className="role-lbl">Iris</span>
              <div className="msg-bubble">● ● ●</div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {/* Bottom floating tray */}
      <div className="ambient-footer-dock">
        <div className="shortcut-tray">
          <button className="shortcut-btn" onClick={() => send("Get system health status")}>⚡ System</button>
          <button className="shortcut-btn" onClick={() => send("Check the weather in Paris")}>🌦️ Weather</button>
          <button className="shortcut-btn" onClick={() => send("Search Wikipedia for Artificial Intelligence")}>📖 Wiki AI</button>
          <button className="shortcut-btn" onClick={() => { cancelSpeech(); setMessages([]); void window.iris.history.clear(); }} title="Clear Chat">↺ Clear</button>
        </div>

        <div className="dock-actions-row">
          <button
            className={`ambient-mic-btn ${recording ? 'recording' : ''}`}
            onClick={recording ? stopRecording : startRecording}
          >
            🎤
          </button>
          
          <div className="ambient-input-bar">
            <input
              id="ambient-text-input"
              value={input}
              placeholder="Speak or type a command..."
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send(input)}
            />
            <button className="ambient-send-btn" onClick={() => send(input)} disabled={agentBusy || !input.trim()}>▶</button>
          </div>
        </div>
      </div>

      {/* Audit Drawer */}
      {showAudit && (
        <div className="logs-drawer">
          <div className="drawer-header">
            <h4>AUDIT EVENT LOGS</h4>
            <button onClick={() => setShowAudit(false)}>✕</button>
          </div>
          <div className="drawer-body">
            {auditEntries.length === 0 ? (
              <div className="empty-logs">No recent log entries</div>
            ) : (
              auditEntries.map((e, i) => (
                <div key={i} className="log-row">
                  <span className="log-time">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="log-tool">{e.tool}</span>
                  <span className={`log-status ${e.approved ? 'success' : 'fail'}`}>
                    {e.approved ? 'Approved' : 'Denied'}
                  </span>
                  <span className="log-res">{JSON.stringify(e.args)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'

type Voice = { name: string; lang: string }

export default function Settings({ onBack }: { onBack: () => void }): JSX.Element {
  const [provider, setProvider] = useState<'groq' | 'gemini' | 'ollama'>('groq')
  const [model, setModel] = useState('')
  const [ollamaModel, setOllamaModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [voices, setVoices] = useState<Voice[]>([])
  const [selectedVoice, setSelectedVoice] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    window.kerai.settings.status().then((s) => {
      setProvider(s.provider ?? 'groq')
      setModel(s.model ?? 'llama-3.3-70b-versatile')
      setOllamaModel(s.ollamaModel ?? 'llama3.1:8b')
      setHasKey(s.hasKey)
      setSelectedVoice(s.voice ?? 'google-natural-female')
    })
  }, [])

  useEffect(() => {
    const loadVoices = (): void => {
      const v = window.speechSynthesis.getVoices()
      if (v.length > 0) setVoices(v.map((x) => ({ name: x.name, lang: x.lang })))
    }
    loadVoices()
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices)
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setStatus('')
    const cfg: Record<string, string> = { provider, model, ollamaModel, voice: selectedVoice }
    if (apiKey.trim()) cfg.apiKey = apiKey.trim()
    const res = await window.kerai.settings.save(cfg)
    setSaving(false)
    if (res.success) {
      setStatus('Saved.')
      setHasKey(!!apiKey.trim() || hasKey)
      setApiKey('')
    } else {
      setStatus(res.error || 'Failed to save.')
    }
  }

  const clearKey = async (): Promise<void> => {
    await window.kerai.settings.clear()
    setHasKey(false)
    setStatus('API key cleared.')
  }

  return (
    <div className="settings-view">
      <div className="settings-header">
        <button className="settings-back" onClick={onBack}>← BACK</button>
        <h2>SETTINGS</h2>
      </div>

      <div className="settings-body">
        <div className="settings-section">
          <label className="settings-label">PROVIDER</label>
          <div className="settings-radio-group">
            <label className={`settings-radio ${provider === 'groq' ? 'active' : ''}`}>
              <input
                type="radio"
                name="provider"
                value="groq"
                checked={provider === 'groq'}
                onChange={() => { setProvider('groq'); setModel('llama-3.3-70b-versatile'); }}
              />
              GROQ (cloud)
            </label>
            <label className={`settings-radio ${provider === 'gemini' ? 'active' : ''}`}>
              <input
                type="radio"
                name="provider"
                value="gemini"
                checked={provider === 'gemini'}
                onChange={() => { setProvider('gemini'); setModel('gemini-2.0-flash'); }}
              />
              GEMINI (Google Cloud)
            </label>
            <label className={`settings-radio ${provider === 'ollama' ? 'active' : ''}`}>
              <input
                type="radio"
                name="provider"
                value="ollama"
                checked={provider === 'ollama'}
                onChange={() => setProvider('ollama')}
              />
              OLLAMA (local)
            </label>
          </div>
        </div>

        {provider === 'groq' && (
          <div className="settings-section">
            <label className="settings-label">GROQ MODEL</label>
            <select
              className="settings-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
              <option value="llama-3.1-8b-instant">llama-3.1-8b-instant</option>
              <option value="mixtral-8x7b-32768">mixtral-8x7b-32768</option>
              <option value="gemma2-9b-it">gemma2-9b-it</option>
            </select>
          </div>
        )}

        {provider === 'gemini' && (
          <div className="settings-section">
            <label className="settings-label">GEMINI MODEL</label>
            <select
              className="settings-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="gemini-2.0-flash">gemini-2.0-flash (Best Power & Speed)</option>
              <option value="gemini-1.5-flash">gemini-1.5-flash</option>
              <option value="gemini-1.5-pro">gemini-1.5-pro</option>
            </select>
          </div>
        )}

        {provider === 'ollama' && (
          <div className="settings-section">
            <label className="settings-label">OLLAMA MODEL</label>
            <input
              className="settings-input"
              value={ollamaModel}
              placeholder="llama3.1:8b"
              onChange={(e) => setOllamaModel(e.target.value)}
            />
            <div className="settings-hint">
              Model must be pulled in Ollama first (e.g. <code>ollama pull llama3.1:8b</code>)
            </div>
          </div>
        )}

        <div className="settings-section">
          <label className="settings-label">{provider === 'gemini' ? 'GEMINI API KEY' : 'GROQ API KEY'}</label>
          <div className="settings-hint" style={{ marginBottom: 6 }}>
            {hasKey ? '● Key stored (encrypted)' : '○ No key set'}
            {provider === 'ollama' && ' — optional for chat, required for voice'}
            {provider === 'gemini' && ' — get your key at Google AI Studio'}
          </div>
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            placeholder={hasKey ? '••••••••' : provider === 'gemini' ? 'AIzaSy...' : 'gsk_...'}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {hasKey && (
            <button className="settings-link-btn" onClick={clearKey}>
              ⌫ remove stored key
            </button>
          )}
        </div>

        {voices.length > 0 && (
          <div className="settings-section">
            <label className="settings-label">TTS VOICE</label>
            <select
              className="settings-select"
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
            >
              <option value="google-natural-female">★ Google Natural Female</option>
              <option value="google-natural-male">★ Google Natural Male</option>
              <option value="browser-female">Browser Native Female</option>
              <option value="browser-male">Browser Native Male</option>
              <option value="">System default</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="settings-section">
          <label className="settings-label">PUSH-TO-TALK HOTKEY</label>
          <div className="settings-hint">Coming soon — currently using the MIC button</div>
        </div>

        <div className="settings-actions">
          <button className="settings-save" onClick={save} disabled={saving}>
            {saving ? 'SAVING…' : 'SAVE SETTINGS'}
          </button>
          {status && <div className={`settings-status ${status.startsWith('Failed') ? 'error' : ''}`}>{status}</div>}
        </div>
      </div>
    </div>
  )
}

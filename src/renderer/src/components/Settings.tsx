import { useEffect, useState } from 'react'

type Voice = { name: string; lang: string }

export default function Settings({ onBack }: { onBack: () => void }): JSX.Element {
  const [model, setModel] = useState('gemini-2.0-flash')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [voices, setVoices] = useState<Voice[]>([])
  const [selectedVoice, setSelectedVoice] = useState('google-natural-female')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [elevenKey, setElevenKey] = useState('')
  const [hasElevenKey, setHasElevenKey] = useState(false)
  const [elevenVoiceId, setElevenVoiceId] = useState('21m00Tcm4TlvDq8ikWAM')

  useEffect(() => {
    window.kerai.settings.status().then((s) => {
      setModel(s.model ?? 'gemini-2.0-flash')
      setHasKey(s.hasKey)
      setSelectedVoice(s.voice ?? 'google-natural-female')
      setHasElevenKey((s as any).hasElevenKey)
      setElevenVoiceId((s as any).elevenVoiceId ?? '21m00Tcm4TlvDq8ikWAM')
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
    const cfg: Record<string, string> = { model, voice: selectedVoice, elevenLabsVoiceId: elevenVoiceId }
    if (apiKey.trim()) cfg.apiKey = apiKey.trim()
    if (elevenKey.trim()) cfg.elevenLabsApiKey = elevenKey.trim()
    const res = await window.kerai.settings.save(cfg)
    setSaving(false)
    if (res.success) {
      setStatus('Saved.')
      setHasKey(!!apiKey.trim() || hasKey)
      setHasElevenKey(!!elevenKey.trim() || hasElevenKey)
      setApiKey('')
      setElevenKey('')
    } else {
      setStatus(res.error || 'Failed to save.')
    }
  }

  const clearKey = async (): Promise<void> => {
    await window.kerai.settings.clear()
    setHasKey(false)
    setHasElevenKey(false)
    setStatus('Settings cleared.')
  }

  return (
    <div className="settings-view">
      <div className="settings-header">
        <button className="settings-back" onClick={onBack}>← BACK</button>
        <h2>SETTINGS</h2>
      </div>

      <div className="settings-body">
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

        <div className="settings-section">
          <label className="settings-label">GEMINI API KEY</label>
          <div className="settings-hint" style={{ marginBottom: 6 }}>
            {hasKey ? '● Key stored (encrypted)' : '○ No key set'} — get your key at Google AI Studio
          </div>
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            placeholder={hasKey ? '••••••••' : 'AIzaSy...'}
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
              <option value="eleven-female">★ ElevenLabs Female (Rachel)</option>
              <option value="eleven-male">★ ElevenLabs Male (Adam)</option>
              <option value="eleven-custom">★ ElevenLabs Custom Voice ID</option>
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
          <label className="settings-label">ELEVENLABS API KEY</label>
          <div className="settings-hint" style={{ marginBottom: 6 }}>
            {hasElevenKey ? '● ElevenLabs key stored' : '○ No ElevenLabs key set'} — required for ElevenLabs voices
          </div>
          <input
            className="settings-input"
            type="password"
            value={elevenKey}
            placeholder={hasElevenKey ? '••••••••' : 'xi-apiKey...'}
            onChange={(e) => setElevenKey(e.target.value)}
          />
        </div>

        <div className="settings-section">
          <label className="settings-label">ELEVENLABS CUSTOM VOICE ID</label>
          <input
            className="settings-input"
            value={elevenVoiceId}
            placeholder="21m00Tcm4TlvDq8ikWAM"
            onChange={(e) => setElevenVoiceId(e.target.value)}
          />
          <div className="settings-hint">
            Specify a custom voice ID from ElevenLabs dashboard (e.g. Rachel, Adam, or your cloned voices)
          </div>
        </div>

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

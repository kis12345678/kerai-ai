import { useState } from 'react'

export default function Setup({ onDone }: { onDone: () => void }): JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const save = async (): Promise<void> => {
    if (!key.trim()) return
    setBusy(true)
    setErr('')
    const res = await window.kerai.settings.save({ apiKey: key.trim() })
    setBusy(false)
    if (res.success) onDone()
    else setErr(res.error || 'Could not save key.')
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="big">KERAI</div>
        <p>
          Paste a Google Gemini API key to bring KERAI online. The key is encrypted by your OS and
          stays on this machine — it is never exposed to the interface.
        </p>
        {err && <div className="err">{err}</div>}
        <label>GEMINI API KEY</label>
        <input
          type="password"
          value={key}
          placeholder="AIzaSy..."
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button onClick={save} disabled={busy || !key.trim()}>
          {busy ? 'LINKING…' : 'INITIALISE'}
        </button>
        <p style={{ marginTop: 18, marginBottom: 0 }}>
          Get one free at <a>aistudio.google.com</a>
        </p>
      </div>
    </div>
  )
}

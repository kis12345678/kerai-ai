import { useEffect, useState } from 'react'
import Setup from './components/Setup'
import Console from './components/Console'
import Settings from './components/Settings'

function Titlebar({ onSettings }: { onSettings: () => void }): JSX.Element {
  return (
    <div className="titlebar">
      <div className="brand">◈ I R I S</div>
      <div className="win-btns">
        <button onClick={onSettings} title="Settings">⚙</button>
        <button onClick={() => window.iris.window.minimize()}>—</button>
        <button onClick={() => window.iris.window.toggleMaximize()}>▢</button>
        <button onClick={() => window.iris.window.close()}>✕</button>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const [ready, setReady] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [provider, setProvider] = useState<string>('groq')
  const [windowState, setWindowState] = useState<'normal' | 'widget'>('normal')

  const refresh = async (): Promise<void> => {
    const status = await window.iris.settings.status()
    setHasKey(status.hasKey)
    setProvider(status.provider ?? 'groq')
    setReady(true)
  }

  useEffect(() => {
    refresh()
    const unsub = window.iris.window.onStateChanged((data) => {
      setWindowState(data.state)
    })
    return () => unsub()
  }, [])

  return (
    <div className={windowState === 'widget' ? 'widget-active' : 'app-container'} style={{ height: '100%' }}>
      {windowState === 'widget' && (
        <div className="widget-click-zone" onClick={() => window.iris.window.restore()} title="Click to open IRIS">
          <div className="orb-3d">
            <div className="siri-orb"></div>
            <div className="orb-ring r1"></div>
            <div className="orb-ring r2"></div>
            <div className="orb-ring r3"></div>
          </div>
        </div>
      )}

      <div className="main-content" style={windowState === 'widget' ? { display: 'none' } : { height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Titlebar onSettings={() => setShowSettings((v) => !v)} />
        <div style={{ flex: 1, height: 'calc(100% - 42px)', overflow: 'hidden' }}>
          {!ready ? (
            <div className="setup">
              <div className="setup-card">
                <div className="big">IRIS</div>
                <p>booting…</p>
              </div>
            </div>
          ) : showSettings ? (
            <Settings onBack={() => { setShowSettings(false); refresh() }} />
          ) : hasKey || provider === 'ollama' ? (
            <Console onReset={refresh} />
          ) : (
            <Setup onDone={refresh} />
          )}
        </div>
      </div>
    </div>
  )
}

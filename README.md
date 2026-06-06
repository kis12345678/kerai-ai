# IRIS — Secure Voice-First Desktop Assistant

A working AI assistant you own. Text + voice chat powered by Groq, built on a
locked-down Electron architecture (the corrected version of the patterns in the
`201Harsh/IRIS-AI` reference demo).

## What works right now
- 💬 Text chat with a fast LLM (Groq)
- 🎙️ Voice input — click MIC, speak, click STOP (transcribed by Groq Whisper)
- 🔊 Spoken replies (offline TTS, no key needed)
- 📊 Live system panel
- 🔐 API key encrypted by your OS, kept in the main process — never exposed to the UI

## Run it (Windows / Mac / Linux)
```bash
npm install
npm run dev
```
On first launch it asks for a **Groq API key** (free at console.groq.com/keys).
Paste it, click INITIALISE, and start talking.

To make an installable .exe later: `npm run build:win`

## Why this is safe (vs the demo)
- `sandbox`, `contextIsolation`, `webSecurity` all ON
- Content-Security-Policy added in production (the demo deleted it)
- Preload exposes a FIXED allowlist — the renderer can't call arbitrary IPC
- Key storage REFUSES plaintext fallback (the demo base64'd it)
- Only the microphone permission is granted; everything else denied

## The rule for adding any new capability
1. Add an `ipcMain.handle(...)` in `src/main/handlers/<name>.ts`, register it in
   `src/main/index.ts`.
2. Add a matching named method in `src/preload/index.ts`.

If it changes the machine (files, shell, input control), put a user-confirmation
step inside the handler before it acts. Never ship raw shell execution.

## Project map
```
src/main/         → main process (privileged; talks to Groq, holds the key)
  index.ts        → window + security setup
  handlers/       → one file per capability
src/preload/      → the allowlist bridge (the security boundary)
src/renderer/     → the UI (React; can ONLY call what preload exposes)
```

## Next ideas
- Swap the model in settings (edit `getModel()` default, e.g. another Groq model)
- Add a local Ollama option for fully offline chat
- Port the human-path mouse automation from the demo — through the safe pattern above

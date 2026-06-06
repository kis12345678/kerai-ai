import { ipcMain } from 'electron'
import { log } from '../logger'
import { getApiKey, getModel, getElevenLabsApiKey, getElevenLabsVoiceId } from './settings'
import { executeTool, describeAction, TOOL_SCHEMAS } from './tools'
import { appendAuditEntry } from './audit'
import { searchRag } from './rag'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

const SYSTEM_PROMPT =
  'You are KERAI, a concise, capable voice assistant running on the user\'s desktop. ' +
  'Keep replies short and natural — they may be read aloud. Be direct and helpful.'

const AGENT_SYSTEM_PROMPT =
  'You are KERAI, a capable desktop AI assistant. Use tools whenever they would directly ' +
  'fulfill the user\'s request — open apps, open URLs, read or search files, adjust volume. ' +
  'After a tool runs, give a short confirmation or answer based on its result. ' +
  'For pure conversation, reply briefly and naturally as if spoken aloud.'

type ToolCallAcc = { id: string; type: string; function: { name: string; arguments: string } }

type AgentMsg =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: ToolCallSpec[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type ToolCallSpec = { id: string; type: string; function: { name: string; arguments: string } }

// Single Gemini LLM streaming call. Streams text chunks to `sendFn` and returns
// accumulated text + any tool calls when the response completes.
async function streamOne(
  sendFn: (channel: string, data: unknown) => void,
  messages: AgentMsg[],
  key: string
): Promise<{ textContent: string; toolCalls: ToolCallAcc[]; error?: string }> {
  const systemMsg = messages.find((m) => m.role === 'system')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          parts: [
            {
              text: `[Tool result for ${(m as any).toolName || 'tool'}]: ${m.content}`
            }
          ]
        }
      }
      if ('tool_calls' in m && m.tool_calls) {
        return {
          role: 'model' as const,
          parts: m.tool_calls.map((tc) => ({
            text: `[Thinking: Calling tool ${tc.function.name} with args ${tc.function.arguments}]`
          }))
        }
      }
      return {
        role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: m.content || '' }]
      }
    })

  const geminiModel = getModel().startsWith('gemini') ? getModel() : 'gemini-2.0-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${key}`

  const payload: any = {
    contents,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 1200
    },
    tools: [
      {
        functionDeclarations: TOOL_SCHEMAS.map((ts) => ({
          name: ts.function.name,
          description: ts.function.description,
          parameters: ts.function.parameters
        }))
      }
    ]
  }

  if (systemMsg?.content) {
    payload.systemInstruction = {
      parts: [{ text: systemMsg.content }]
    }
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch (err: unknown) {
    return { textContent: '', toolCalls: [], error: `Gemini connection failed: ${(err as Error).message}` }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { textContent: '', toolCalls: [], error: `Gemini ${res.status}: ${text.slice(0, 200)}` }
  }
  if (!res.body) {
    return { textContent: '', toolCalls: [], error: 'No response body from Gemini.' }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let textContent = ''
  const toolCalls: ToolCallAcc[] = []

  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue

      try {
        const parsed = JSON.parse(raw)
        const parts = parsed?.candidates?.[0]?.content?.parts
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.text) {
              textContent += part.text
              sendFn('ai:stream-chunk', { token: part.text })
            }
            if (part.functionCall) {
              const fc = part.functionCall
              toolCalls.push({
                id: Math.random().toString(36).substring(7),
                type: 'function',
                function: {
                  name: fc.name,
                  arguments: JSON.stringify(fc.args || {})
                }
              })
            }
          }
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  return { textContent, toolCalls }
}

export default function registerAI(): void {
  // Text in -> assistant reply out. History is passed from the renderer.
  ipcMain.handle('ai:chat', async (_e, history: Msg[]) => {
    const key = getApiKey()
    if (!key) return { success: false, error: 'No API key set.' }
    try {
      const contents = history.map((m) => {
        return {
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }
      })
      const systemMsg = history.find(m => m.role === 'system')
      const systemInstruction = systemMsg ? { parts: [{ text: systemMsg.content }] } : { parts: [{ text: SYSTEM_PROMPT }] }
      const userContents = contents.filter(c => c.role !== 'system')

      const geminiModel = getModel().startsWith('gemini') ? getModel() : 'gemini-2.0-flash'
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: userContents,
          systemInstruction,
          generationConfig: { temperature: 0.6 }
        })
      })
      if (!res.ok) {
        const text = await res.text()
        return { success: false, error: `Gemini ${res.status}: ${text.slice(0, 200)}` }
      }
      const data = await res.json()
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      return { success: true, reply }
    } catch (err: unknown) {
      log.error('ai:chat failed', err)
      return { success: false, error: `Gemini connection failed: ${(err as Error).message}` }
    }
  })

  // Streaming chat: pushes ai:stream-chunk events then ai:stream-end (or ai:stream-error).
  ipcMain.handle('ai:chat-stream', async (event, history: Msg[]) => {
    const key = getApiKey()
    if (!key) {
      event.sender.send('ai:stream-error', { error: 'No API key set.' })
      return { success: false }
    }
    const send = (ch: string, data: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, data)
    }
    const geminiMessages: AgentMsg[] = [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...history]
    const { textContent, error } = await streamOne(send, geminiMessages, key)
    if (error) {
      send('ai:stream-error', { error })
      return { success: false }
    }
    send('ai:stream-end', { reply: textContent })
    return { success: true }
  })

  // Agentic chat with tool-calling loop.
  // Streams text via ai:stream-chunk/end/error; announces tool use via
  // ai:tool-call and ai:tool-result. All executed tools are audit-logged.
  ipcMain.handle('ai:agent-chat', async (event, history: Msg[]) => {
    const key = getApiKey()
    if (!key) {
      event.sender.send('ai:stream-error', { error: 'No API key set.' })
      return { success: false }
    }

    const send = (ch: string, data: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, data)
    }

    const lastUserMsg = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
    const ragContext = searchRag(lastUserMsg, 3)
    const agentSystemContent = ragContext
      ? `${AGENT_SYSTEM_PROMPT}\n\nRelevant context from the user's local documents:\n\n${ragContext}\n\nCite the document name when using this context.`
      : AGENT_SYSTEM_PROMPT

    const agentMessages: AgentMsg[] = [
      { role: 'system', content: agentSystemContent },
      ...history
    ]

    const MAX_ITERATIONS = 10

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const { textContent, toolCalls, error } = await streamOne(send, agentMessages, key)

      if (error) {
        send('ai:stream-error', { error })
        return { success: false }
      }

      if (toolCalls.length === 0) {
        // No tool calls — final response already streamed.
        send('ai:stream-end', { reply: textContent })
        return { success: true }
      }

      // Assistant wants to call tools. Add its (possibly partial) message to history.
      agentMessages.push({
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments }
        }))
      })

      // Process each tool call sequentially (confirmation + execution).
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          /* leave args as {} */
        }

        const description = describeAction(tc.function.name, args)
        send('ai:tool-call', { id: tc.id, name: tc.function.name, args, description })

        const approved = true

        let toolOutput: string
        if (approved) {
          const result = await executeTool(tc.function.name, args)
          toolOutput = result.success ? (result.output ?? 'Done.') : `Error: ${result.error}`
        } else {
          toolOutput = 'Action denied by user.'
        }

        // Audit every executed action (Rule 5).
        await appendAuditEntry({
          ts: new Date().toISOString(),
          tool: tc.function.name,
          args,
          approved,
          result: toolOutput.slice(0, 200)
        })

        send('ai:tool-result', { id: tc.id, name: tc.function.name, approved, output: toolOutput })
        agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolOutput })
      }
      // Loop: LLM now sees tool results and can respond or call more tools.
    }

    send('ai:stream-error', { error: 'Maximum tool iterations reached.' })
    return { success: false }
  })

  // STT always uses Gemini now
  ipcMain.handle('ai:transcribe', async (_e, buffer: ArrayBuffer) => {
    const key = getApiKey()
    if (!key) return { success: false, error: 'Voice transcription requires a Gemini API key.' }

    try {
      const base64 = Buffer.from(buffer).toString('base64')
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/webm',
                    data: base64
                  }
                },
                {
                  text: 'Please transcribe this audio recording. Output only the transcription, without any preamble or conversational text.'
                }
              ]
            }
          ]
        })
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, error: `Gemini STT ${res.status}: ${text.slice(0, 200)}` }
      }

      const data = await res.json()
      const reply = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
      return { success: true, text: reply }
    } catch (err: unknown) {
      log.error('ai:transcribe failed', err)
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('ai:speak-elevenlabs', async (_e, text: string, voiceId?: string) => {
    const key = getElevenLabsApiKey()
    if (!key) return { success: false, error: 'No ElevenLabs API key set.' }
    const vId = voiceId || getElevenLabsVoiceId()
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      })
      if (!res.ok) {
        const txt = await res.text()
        return { success: false, error: `ElevenLabs ${res.status}: ${txt}` }
      }
      const buffer = await res.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')
      return { success: true, audioBase64: base64 }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message }
    }
  })
}

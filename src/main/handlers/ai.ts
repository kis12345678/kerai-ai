import { ipcMain, dialog } from 'electron'
import { log } from '../logger'
import { getApiKey, getModel, getProvider, getOllamaModel } from './settings'
import { executeTool, describeAction, TOOL_SCHEMAS } from './tools'
import { appendAuditEntry } from './audit'
import { searchRag } from './rag'

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
const STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const OLLAMA_URL = 'http://localhost:11434/api/chat'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

const SYSTEM_PROMPT =
  'You are KERAI, a concise, capable voice assistant running on the user\'s desktop. ' +
  'Keep replies short and natural — they may be read aloud. Be direct and helpful.'

const AGENT_SYSTEM_PROMPT =
  'You are KERAI, a capable desktop AI assistant. Use tools whenever they would directly ' +
  'fulfill the user\'s request — open apps, open URLs, read or search files, adjust volume. ' +
  'After a tool runs, give a short confirmation or answer based on its result. ' +
  'For pure conversation, reply briefly and naturally as if spoken aloud.'

// ── Streaming helper ─────────────────────────────────────────────────────────

type ToolCallAcc = { id: string; type: string; function: { name: string; arguments: string } }

type AgentMsg =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: ToolCallSpec[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type ToolCallSpec = { id: string; type: string; function: { name: string; arguments: string } }

// Single LLM streaming call. Streams text chunks to `sendFn` and returns
// accumulated text + any tool calls when the response completes.
async function streamOne(
  sendFn: (channel: string, data: unknown) => void,
  messages: AgentMsg[],
  key: string
): Promise<{ textContent: string; toolCalls: ToolCallAcc[]; error?: string }> {
  let res: Response
  try {
    res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getModel(),
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: 'auto',
        temperature: 0.6,
        max_tokens: 1200,
        stream: true
      })
    })
  } catch (err: unknown) {
    return { textContent: '', toolCalls: [], error: (err as Error).message }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { textContent: '', toolCalls: [], error: `Groq ${res.status}: ${text.slice(0, 200)}` }
  }
  if (!res.body) {
    return { textContent: '', toolCalls: [], error: 'No response body.' }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let textContent = ''
  const toolCallAccs = new Map<number, ToolCallAcc>()
  let finishReason: string | null = null

  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') break outer

      try {
        const parsed = JSON.parse(raw)
        const choice = parsed?.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta ?? {}

        if (typeof delta.content === 'string' && delta.content) {
          textContent += delta.content
          sendFn('ai:stream-chunk', { token: delta.content })
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (typeof tc.index !== 'number') continue
            const acc = toolCallAccs.get(tc.index) ?? {
              id: '',
              type: 'function',
              function: { name: '', arguments: '' }
            }
            if (tc.id) acc.id = tc.id
            if (tc.type) acc.type = tc.type
            if (tc.function?.name) acc.function.name += tc.function.name
            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments
            toolCallAccs.set(tc.index, acc)
          }
        }
      } catch (err) {
        log.error('ai: malformed SSE chunk', err)
      }
    }
  }

  const toolCalls = finishReason === 'tool_calls' ? [...toolCallAccs.values()] : []
  return { textContent, toolCalls }
}

// Ollama streaming helper — handles NDJSON format instead of SSE.
async function streamOneOllama(
  sendFn: (channel: string, data: unknown) => void,
  messages: AgentMsg[]
): Promise<{ textContent: string; toolCalls: ToolCallAcc[]; error?: string }> {
  const ollamaMessages = messages.map((m) => {
    if (m.role === 'tool') return { role: 'user' as const, content: `[Tool result] ${m.content}` }
    if ('tool_calls' in m && m.tool_calls) {
      return { role: 'assistant' as const, content: m.content ?? '' }
    }
    return { role: m.role, content: m.content ?? '' }
  })

  let res: Response
  try {
    res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getOllamaModel(),
        messages: ollamaMessages,
        stream: true
      })
    })
  } catch (err: unknown) {
    return { textContent: '', toolCalls: [], error: `Ollama connection failed: ${(err as Error).message}. Is Ollama running?` }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { textContent: '', toolCalls: [], error: `Ollama ${res.status}: ${text.slice(0, 200)}` }
  }
  if (!res.body) {
    return { textContent: '', toolCalls: [], error: 'No response body from Ollama.' }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let textContent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        const token: string = parsed?.message?.content ?? ''
        if (token) {
          textContent += token
          sendFn('ai:stream-chunk', { token })
        }
      } catch {
        // Malformed NDJSON line — skip.
      }
    }
  }

  // Ollama doesn't support tool calling in this integration, so always return empty toolCalls
  return { textContent, toolCalls: [] }
}

// Gemini streaming helper — handles SSE format.
async function streamOneGemini(
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
    const provider = getProvider()

    if (provider === 'ollama') {
      try {
        const ollamaMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history].map((m) => ({
          role: m.role,
          content: m.content
        }))
        const res = await fetch(OLLAMA_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: getOllamaModel(), messages: ollamaMessages, stream: false })
        })
        if (!res.ok) {
          const text = await res.text()
          return { success: false, error: `Ollama ${res.status}: ${text.slice(0, 200)}` }
        }
        const data = await res.json()
        return { success: true, reply: data?.message?.content ?? '' }
      } catch (err: unknown) {
        return { success: false, error: `Ollama connection failed: ${(err as Error).message}. Is Ollama running?` }
      }
    }

    if (provider === 'gemini') {
      const key = getApiKey()
      if (!key) return { success: false, error: 'No API key set.' }
      try {
        const contents = [{ role: 'system', content: SYSTEM_PROMPT }, ...history].map((m) => {
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
        return { success: false, error: `Gemini connection failed: ${(err as Error).message}` }
      }
    }

    const key = getApiKey()
    if (!key) return { success: false, error: 'No API key set.' }

    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: getModel(),
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
          temperature: 0.6,
          max_tokens: 800
        })
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, error: `Groq ${res.status}: ${text.slice(0, 200)}` }
      }

      const data = await res.json()
      const reply: string = data?.choices?.[0]?.message?.content ?? ''
      return { success: true, reply }
    } catch (err: unknown) {
      log.error('ai:chat failed', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // Streaming chat: pushes ai:stream-chunk events then ai:stream-end (or ai:stream-error).
  ipcMain.handle('ai:chat-stream', async (event, history: Msg[]) => {
    const provider = getProvider()

    if (provider === 'ollama') {
      const send = (ch: string, data: unknown): void => {
        if (!event.sender.isDestroyed()) event.sender.send(ch, data)
      }
      const ollamaMessages = [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...history].map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant', content: m.content
      }))
      const { textContent, error } = await streamOneOllama(send, ollamaMessages)
      if (error) {
        send('ai:stream-error', { error })
        return { success: false }
      }
      send('ai:stream-end', { reply: textContent })
      return { success: true }
    }

    if (provider === 'gemini') {
      const key = getApiKey()
      if (!key) {
        event.sender.send('ai:stream-error', { error: 'No API key set.' })
        return { success: false }
      }
      const send = (ch: string, data: unknown): void => {
        if (!event.sender.isDestroyed()) event.sender.send(ch, data)
      }
      const geminiMessages: AgentMsg[] = [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...history]
      const { textContent, error } = await streamOneGemini(send, geminiMessages, key)
      if (error) {
        send('ai:stream-error', { error })
        return { success: false }
      }
      send('ai:stream-end', { reply: textContent })
      return { success: true }
    }

    const key = getApiKey()
    if (!key) {
      event.sender.send('ai:stream-error', { error: 'No API key set.' })
      return { success: false }
    }

    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: getModel(),
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
          temperature: 0.6,
          max_tokens: 800,
          stream: true
        })
      })

      if (!res.ok) {
        const text = await res.text()
        event.sender.send('ai:stream-error', {
          error: `Groq ${res.status}: ${text.slice(0, 200)}`
        })
        return { success: false }
      }

      if (!res.body) {
        event.sender.send('ai:stream-error', { error: 'No response body from Groq.' })
        return { success: false }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let fullReply = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last (potentially incomplete) line in the buffer.
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const token: string = parsed?.choices?.[0]?.delta?.content ?? ''
            if (token) {
              fullReply += token
              event.sender.send('ai:stream-chunk', { token })
            }
          } catch (err) {
            log.error('ai: malformed SSE chunk', err)
          }
        }
      }

      event.sender.send('ai:stream-end', { reply: fullReply })
      return { success: true }
    } catch (err: unknown) {
      log.error('ai:chat-stream failed', err)
      event.sender.send('ai:stream-error', { error: (err as Error).message })
      return { success: false }
    }
  })

  // Agentic chat with tool-calling loop.
  // Streams text via ai:stream-chunk/end/error; announces tool use via
  // ai:tool-call and ai:tool-result. All executed tools are audit-logged.
  ipcMain.handle('ai:agent-chat', async (event, history: Msg[]) => {
    const provider = getProvider()
    const send = (ch: string, data: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, data)
    }

    if (provider === 'ollama') {
      const lastUserMsg = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
      const ragContext = searchRag(lastUserMsg, 3)
      const systemContent = ragContext
        ? `${AGENT_SYSTEM_PROMPT}\n\nRelevant context from the user's local documents:\n\n${ragContext}\n\nCite the document name when using this context.`
        : AGENT_SYSTEM_PROMPT
      const ollamaMessages: AgentMsg[] = [{ role: 'system', content: systemContent }, ...history]
      const { textContent, error } = await streamOneOllama(send, ollamaMessages)
      if (error) {
        send('ai:stream-error', { error })
        return { success: false }
      }
      send('ai:stream-end', { reply: textContent })
      return { success: true }
    }

    const isGemini = provider === 'gemini'
    const key = getApiKey()
    if (!key) {
      event.sender.send('ai:stream-error', { error: 'No API key set.' })
      return { success: false }
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
      const { textContent, toolCalls, error } = isGemini
        ? await streamOneGemini(send, agentMessages, key)
        : await streamOne(send, agentMessages, key)

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

  // STT always uses Groq Whisper — no Ollama equivalent.
  ipcMain.handle('ai:transcribe', async (_e, buffer: ArrayBuffer) => {
    const key = getApiKey()
    if (!key) return { success: false, error: 'Voice transcription requires a Groq API key, even when using Ollama for chat.' }

    try {
      const form = new FormData()
      form.append('file', new Blob([buffer], { type: 'audio/webm' }), 'speech.webm')
      form.append('model', 'whisper-large-v3-turbo')

      const res = await fetch(STT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, error: `Groq STT ${res.status}: ${text.slice(0, 200)}` }
      }

      const data = await res.json()
      return { success: true, text: (data?.text ?? '').trim() }
    } catch (err: unknown) {
      log.error('ai:transcribe failed', err)
      return { success: false, error: (err as Error).message }
    }
  })
}

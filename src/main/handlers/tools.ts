import { shell, app, BrowserWindow } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import {
  isAutomationEnabled,
  toolMouseMove,
  toolMouseClick,
  toolTypeText,
  toolPressKey
} from './automation'

const execFileAsync = promisify(execFile)

// PowerShell -EncodedCommand accepts base64(UTF-16LE); avoids all quoting issues.
function psEncoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export async function toolGetSystemStatus(): Promise<ToolResult> {
  const totalMemGB = (os.totalmem() / 1024 ** 3).toFixed(1)
  const freeMemGB = (os.freemem() / 1024 ** 3).toFixed(1)
  return {
    success: true,
    output: `System Info: Platform: ${process.platform}, CPU Cores: ${os.cpus().length}, Memory Total: ${totalMemGB} GB, Free: ${freeMemGB} GB, Uptime: ${(os.uptime() / 3600).toFixed(1)} hours.`
  }
}

export async function toolPlayMediaAction(action: string): Promise<ToolResult> {
  const codes: Record<string, number> = {
    mute: 173,
    volume_down: 174,
    volume_up: 175,
    next_track: 176,
    prev_track: 177,
    play_pause: 179
  }
  const code = codes[action]
  if (!code) return { success: false, error: `Unknown media action: ${action}` }
  try {
    const encoded = psEncoded(`(New-Object -ComObject WScript.Shell).SendKeys([char]${code})`)
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 3000 })
    return { success: true, output: `Executed media action: ${action}.` }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

export async function toolSetTimerReminder(durationSeconds: number, message: string): Promise<ToolResult> {
  setTimeout(() => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0 && !wins[0].isDestroyed()) {
      wins[0].webContents.send('ai:speak-request', { text: message })
    }
  }, durationSeconds * 1000)
  return { success: true, output: `Timer set for ${durationSeconds} seconds with message: "${message}".` }
}

export async function toolSystemPowerControl(action: string): Promise<ToolResult> {
  if (process.platform !== 'win32') return { success: false, error: 'Only supported on Windows.' }
  let command = ''
  if (action === 'shutdown') {
    command = 'shutdown /s /t 0'
  } else if (action === 'restart') {
    command = 'shutdown /r /t 0'
  } else if (action === 'sleep') {
    command = 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'
  }
  try {
    const encoded = psEncoded(command)
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 3000 })
    return { success: true, output: `Computer set to ${action}.` }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

export async function toolGetWeather(location: string): Promise<ToolResult> {
  try {
    const loc = encodeURIComponent(location.trim())
    const res = await fetch(`https://wttr.in/${loc}?format=3`)
    if (!res.ok) {
      return { success: false, error: `Failed to fetch weather: ${res.statusText}` }
    }
    const text = await res.text()
    return { success: true, output: text.trim() }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

export async function toolWikipediaSearch(query: string): Promise<ToolResult> {
  try {
    const topic = encodeURIComponent(query.trim())
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${topic}`)
    if (!res.ok) {
      if (res.status === 404) {
        return { success: false, error: `Topic "${query}" not found on Wikipedia.` }
      }
      return { success: false, error: `Failed to search Wikipedia: ${res.statusText}` }
    }
    const data = await res.json()
    const extract = data.extract || 'No summary extract available.'
    return { success: true, output: extract }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

// ── App allowlist ────────────────────────────────────────────────────────────
// Values are the names/commands Start-Process accepts on Windows.
const APP_ALLOWLIST: Record<string, string> = {
  notepad: 'notepad',
  calculator: 'calc',
  calc: 'calc',
  explorer: 'explorer',
  chrome: 'chrome',
  firefox: 'firefox',
  vscode: 'code',
  code: 'code',
  terminal: 'cmd',
  cmd: 'cmd',
  powershell: 'powershell',
  edge: 'msedge',
  paint: 'mspaint',
  wordpad: 'wordpad',
  teams: 'teams',
  slack: 'slack',
  brave: 'brave',
  discord: 'discord',
}

// ── Allowed base directories for file read/search ────────────────────────────
const allowedBases = (): string[] => [
  app.getPath('home'),
  app.getPath('documents'),
  app.getPath('downloads'),
  app.getPath('desktop'),
  app.getPath('pictures'),
  app.getPath('music'),
  app.getPath('videos'),
]

const MAX_READ_BYTES = 50 * 1024

// ── Tool result type ─────────────────────────────────────────────────────────
export type ToolResult = { success: boolean; output?: string; error?: string }

// ── Tool implementations ─────────────────────────────────────────────────────

export async function toolOpenApp(name: string): Promise<ToolResult> {
  const target = APP_ALLOWLIST[name.toLowerCase().trim()]
  if (!target) return { success: false, error: `"${name}" is not in the allowed app list.` }

  const encoded = psEncoded(`Start-Process ${target}`)
  try {
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 5000 }
    )
    return { success: true, output: `Launched ${name}.` }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

export async function toolOpenUrl(url: string): Promise<ToolResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { success: false, error: `Invalid URL: ${url}` }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { success: false, error: 'Only http/https URLs are allowed.' }
  }
  await shell.openExternal(url)
  return { success: true, output: `Opened ${url} in browser.` }
}

export async function toolSearchFiles(query: string, scope?: string): Promise<ToolResult> {
  if (process.platform !== 'win32') return { success: false, error: 'Only supported on Windows.' }

  const scopeDirs: Record<string, () => string> = {
    home: () => app.getPath('home'),
    documents: () => app.getPath('documents'),
    downloads: () => app.getPath('downloads'),
    desktop: () => app.getPath('desktop'),
  }
  const scopeDir = (scopeDirs[scope ?? 'home'] ?? scopeDirs.home)()
  // Strip characters that could escape the PowerShell -Filter argument.
  const safeQuery = query.replace(/['"`;|&<>]/g, '').slice(0, 80)

  const script = [
    `$r = Get-ChildItem -Path "${scopeDir}" -Recurse -Depth 5 -Filter "*${safeQuery}*" -ErrorAction SilentlyContinue`,
    `$r | Select-Object -First 20 | ForEach-Object { $_.FullName }`
  ].join('; ')

  try {
    const { stdout } = await Promise.race([
      execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(script)]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('search timed out after 10 s')), 10000)
      )
    ])
    const files = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean)
    return { success: true, output: files.length > 0 ? files.join('\n') : 'No files found.' }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

export async function toolReadFile(filePath: string): Promise<ToolResult> {
  const resolved = path.resolve(filePath)
  const inAllowed = allowedBases().some(
    (base) => resolved === base || resolved.startsWith(base + path.sep)
  )
  if (!inAllowed) return { success: false, error: 'Path is outside allowed directories.' }

  try {
    const stat = await fs.stat(resolved)
    if (stat.size > MAX_READ_BYTES) {
      return {
        success: false,
        error: `File too large (${(stat.size / 1024).toFixed(0)} KB; 50 KB limit).`
      }
    }
    const content = await fs.readFile(resolved, 'utf-8')
    return { success: true, output: content }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

export async function toolSetVolume(level: number): Promise<ToolResult> {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Volume control only supported on Windows.' }
  }
  const vol = Math.max(0, Math.min(100, Math.round(level)))
  // Use winmm.dll via Add-Type. Each PS process starts fresh — no type conflict.
  const script = [
    `Add-Type -MemberDefinition '[DllImport("winmm.dll")] public static extern int waveOutSetVolume(IntPtr h, uint v);' -Name "WV" -Namespace "KERAI"`,
    `$v = [uint32]([uint32]::MaxValue * (${vol} / 100.0))`,
    `[KERAI.WV]::waveOutSetVolume([System.IntPtr]::Zero, $v -bor ($v -shl 16))`
  ].join('; ')
  try {
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded(script)],
      { timeout: 5000 }
    )
    return { success: true, output: `Volume set to ${vol}%.` }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'open_app':
      return `open the app "${args.name}"`
    case 'open_url':
      return `open "${args.url}" in your browser`
    case 'search_files':
      return `search for "${args.query}" in ${args.scope ?? 'home'} folder`
    case 'read_file':
      return `read file "${args.path}"`
    case 'set_volume':
      return `set system volume to ${args.level}%`
    case 'mouse_move':
      return `move mouse to (${args.x}, ${args.y})`
    case 'mouse_click':
      return `${args.button ?? 'left'}-click at (${args.x}, ${args.y})`
    case 'keyboard_type':
      return `type "${String(args.text ?? '').slice(0, 40)}${String(args.text ?? '').length > 40 ? '…' : ''}"`
    case 'keyboard_key':
      return `press the ${args.key} key`
    case 'get_system_status':
      return 'retrieve system health and resource status'
    case 'play_media_action':
      return `trigger media action: "${args.action}"`
    case 'set_timer_reminder':
      return `set a timer for ${args.durationSeconds} seconds with message "${args.message}"`
    case 'system_power_control':
      return `set computer power state to "${args.action}"`
    case 'get_weather':
      return `retrieve the weather for "${args.location}"`
    case 'wikipedia_search':
      return `search Wikipedia for "${args.query}"`
    default:
      return `run tool "${toolName}"`
  }
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'open_app':
      return toolOpenApp(String(args.name ?? ''))
    case 'open_url':
      return toolOpenUrl(String(args.url ?? ''))
    case 'search_files':
      return toolSearchFiles(
        String(args.query ?? ''),
        args.scope !== undefined ? String(args.scope) : undefined
      )
    case 'read_file':
      return toolReadFile(String(args.path ?? ''))
    case 'set_volume':
      return toolSetVolume(Number(args.level ?? 50))
    case 'mouse_move':
      if (!isAutomationEnabled()) return { success: false, error: 'Automation is disabled.' }
      return toolMouseMove(Number(args.x ?? 0), Number(args.y ?? 0))
    case 'mouse_click':
      if (!isAutomationEnabled()) return { success: false, error: 'Automation is disabled.' }
      return toolMouseClick(
        Number(args.x ?? 0),
        Number(args.y ?? 0),
        args.button === 'right' ? 'right' : 'left'
      )
    case 'keyboard_type':
      if (!isAutomationEnabled()) return { success: false, error: 'Automation is disabled.' }
      return toolTypeText(String(args.text ?? ''))
    case 'keyboard_key':
      if (!isAutomationEnabled()) return { success: false, error: 'Automation is disabled.' }
      return toolPressKey(String(args.key ?? ''))
    case 'get_system_status':
      return toolGetSystemStatus()
    case 'play_media_action':
      return toolPlayMediaAction(String(args.action ?? ''))
    case 'set_timer_reminder':
      return toolSetTimerReminder(Number(args.durationSeconds ?? 0), String(args.message ?? ''))
    case 'system_power_control':
      return toolSystemPowerControl(String(args.action ?? ''))
    case 'get_weather':
      return toolGetWeather(String(args.location ?? ''))
    case 'wikipedia_search':
      return toolWikipediaSearch(String(args.query ?? ''))
    default:
      return { success: false, error: `Unknown tool: ${toolName}` }
  }
}

// ── Tool schemas (OpenAI function-calling format) ────────────────────────────

export const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'open_app',
      description: 'Launch a desktop application by name.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'App name. Allowed: notepad, calculator, explorer, chrome, firefox, vscode, terminal, edge, paint, wordpad.'
          }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_url',
      description: 'Open a URL in the system default browser. Only http/https allowed.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL including http:// or https://' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for files by name pattern within user folders (max depth 5).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filename keyword or partial name to search for.' },
          scope: {
            type: 'string',
            enum: ['home', 'documents', 'downloads', 'desktop'],
            description: 'Folder to search in. Defaults to home.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description:
        'Read the text content of a file (max 50 KB). Restricted to home, documents, downloads, desktop, pictures, music, and videos.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_volume',
      description: 'Set the system master audio volume.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'number', description: 'Volume level from 0 (mute) to 100 (max).' }
        },
        required: ['level']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'mouse_move',
      description:
        'Move the mouse cursor to an absolute screen position using a smooth Bézier path. Requires Automation to be enabled.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Target X coordinate in pixels.' },
          y: { type: 'number', description: 'Target Y coordinate in pixels.' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'mouse_click',
      description:
        'Move to a screen position then click. Requires Automation to be enabled.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Target X coordinate.' },
          y: { type: 'number', description: 'Target Y coordinate.' },
          button: {
            type: 'string',
            enum: ['left', 'right'],
            description: 'Mouse button to click. Defaults to "left".'
          }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'keyboard_type',
      description:
        'Type a string of text at the current cursor position. Requires Automation to be enabled.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type.' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'keyboard_key',
      description:
        'Press a single named key. Requires Automation to be enabled. Allowed keys: enter, return, escape, tab, space, backspace, delete, home, end, pageup, pagedown, arrowup, arrowdown, arrowleft, arrowright, f5.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            enum: [
              'enter', 'return', 'escape', 'tab', 'space', 'backspace', 'delete',
              'home', 'end', 'pageup', 'pagedown', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'f5'
            ],
            description: 'Key name to press.'
          }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_system_status',
      description: 'Retrieve the current system health and resource usage metrics (CPU, RAM, platform, battery, uptime).'
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'play_media_action',
      description: 'Control Master system media playback commands (play/pause, skip, prev, volume, mute).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play_pause', 'next_track', 'prev_track', 'mute', 'volume_up', 'volume_down'],
            description: 'The media key command to execute.'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_timer_reminder',
      description: 'Set an asynchronous reminder or timer to alert the user with a vocal announcement after a delay.',
      parameters: {
        type: 'object',
        properties: {
          durationSeconds: { type: 'number', description: 'Duration in seconds to wait before triggering the reminder.' },
          message: { type: 'string', description: 'The spoken alert message to announce when the timer expires.' }
        },
        required: ['durationSeconds', 'message']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'system_power_control',
      description: 'Modify the host computer system power state (sleep, restart, or shutdown). Only supported on Windows.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['sleep', 'restart', 'shutdown'],
            description: 'The power state command.'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get current weather conditions for a specified city or location using wttr.in.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The city or location to get the weather for (e.g. "New York", "London").' }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'wikipedia_search',
      description: 'Search Wikipedia for a summary topic page extract.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The topic or term to search on Wikipedia.' }
        },
        required: ['query']
      }
    }
  }
]

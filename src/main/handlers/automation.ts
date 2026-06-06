import { ipcMain, dialog } from 'electron'
import { mouse, keyboard, Button, Key, Point } from '@nut-tree-fork/nut-js'
import { appendAuditEntry } from './audit'
import type { ToolResult } from './tools'

// ── Master toggle (off by default — Rule 5: higher-risk capability) ──────────
let automationEnabled = false
export function isAutomationEnabled(): boolean {
  return automationEnabled
}

// ── Bézier mouse movement ─────────────────────────────────────────────────────
// Cubic Bézier with two randomised control points off the midpoint.
// Produces a natural, slightly curved path rather than instant teleportation.

interface Pt {
  x: number
  y: number
}

function bezierCubic(t: number, p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt {
  const m = 1 - t
  return {
    x: Math.round(m ** 3 * p0.x + 3 * m ** 2 * t * p1.x + 3 * m * t ** 2 * p2.x + t ** 3 * p3.x),
    y: Math.round(m ** 3 * p0.y + 3 * m ** 2 * t * p1.y + 3 * m * t ** 2 * p2.y + t ** 3 * p3.y)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function bezierMove(x: number, y: number): Promise<void> {
  const cur = await mouse.getPosition()
  const dist = Math.hypot(x - cur.x, y - cur.y)
  const steps = Math.max(20, Math.round(dist / 4))
  const spread = Math.max(30, dist * 0.25)
  const rand = () => (Math.random() - 0.5) * spread

  const midX = (cur.x + x) / 2
  const midY = (cur.y + y) / 2
  const cp1: Pt = { x: midX + rand(), y: midY + rand() }
  const cp2: Pt = { x: midX + rand(), y: midY + rand() }

  for (let i = 1; i <= steps; i++) {
    const pt = bezierCubic(i / steps, cur, cp1, cp2, { x, y })
    await mouse.setPosition(new Point(pt.x, pt.y))
    await sleep(4 + Math.random() * 6) // 4–10 ms per step, variable for realism
  }
}

// ── Exported tool executors (used by tools.ts for agent dispatch) ────────────

export async function toolMouseMove(x: number, y: number): Promise<ToolResult> {
  if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
  await bezierMove(x, y)
  return { success: true, output: `Mouse moved to (${x}, ${y}).` }
}

export async function toolMouseClick(
  x: number,
  y: number,
  button: 'left' | 'right' = 'left'
): Promise<ToolResult> {
  if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
  await bezierMove(x, y)
  await mouse.click(button === 'right' ? Button.RIGHT : Button.LEFT)
  return { success: true, output: `${button}-clicked at (${x}, ${y}).` }
}

export async function toolTypeText(text: string): Promise<ToolResult> {
  if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
  await keyboard.type(text)
  return { success: true, output: `Typed ${text.length} characters.` }
}

// Safe subset of Key values the agent can request.
const ALLOWED_KEYS: Record<string, number> = {
  enter: Key.Enter,
  return: Key.Return,
  escape: Key.Escape,
  tab: Key.Tab,
  space: Key.Space,
  backspace: Key.Backspace,
  delete: Key.Delete,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,
  arrowup: Key.Up,
  arrowdown: Key.Down,
  arrowleft: Key.Left,
  arrowright: Key.Right,
  f5: Key.F5,
}

export async function toolPressKey(keyName: string): Promise<ToolResult> {
  if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
  const k = ALLOWED_KEYS[keyName.toLowerCase()]
  if (k === undefined) {
    return { success: false, error: `Key "${keyName}" is not in the allowed list.` }
  }
  await keyboard.pressKey(k)
  await keyboard.releaseKey(k)
  return { success: true, output: `Pressed ${keyName}.` }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

export default function registerAutomation(): void {
  // Toggle — no confirmation; user explicitly opts in.
  ipcMain.handle('automation:status', () => ({ enabled: automationEnabled }))
  ipcMain.handle('automation:toggle', (_e, enable: boolean) => {
    automationEnabled = Boolean(enable)
    return { success: true, enabled: automationEnabled }
  })

  ipcMain.handle('automation:mouse-move', async (_e, args: { x: number; y: number }) => {
    if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
    const approved = true
    const result = await toolMouseMove(args.x, args.y)
    await appendAuditEntry({
      ts: new Date().toISOString(),
      tool: 'mouse_move',
      args: { x: args.x, y: args.y },
      approved,
      result: (result.output ?? result.error ?? '').slice(0, 200)
    })
    return { success: approved, error: approved ? undefined : 'User denied.' }
  })

  ipcMain.handle(
    'automation:click',
    async (_e, args: { x: number; y: number; button?: string }) => {
      if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
      const btn = args.button === 'right' ? 'right' : 'left'
      const approved = true
      const result = await toolMouseClick(args.x, args.y, btn)
      await appendAuditEntry({
        ts: new Date().toISOString(),
        tool: 'mouse_click',
        args: { x: args.x, y: args.y, button: btn },
        approved,
        result: (result.output ?? result.error ?? '').slice(0, 200)
      })
      return { success: approved, error: approved ? undefined : 'User denied.' }
    }
  )

  ipcMain.handle('automation:type', async (_e, args: { text: string }) => {
    if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
    const approved = true
    const result = await toolTypeText(args.text)
    await appendAuditEntry({
      ts: new Date().toISOString(),
      tool: 'keyboard_type',
      args: { text: args.text.slice(0, 100) },
      approved,
      result: (result.output ?? result.error ?? '').slice(0, 200)
    })
    return { success: approved, error: approved ? undefined : 'User denied.' }
  })

  ipcMain.handle('automation:key', async (_e, args: { key: string }) => {
    if (!automationEnabled) return { success: false, error: 'Automation is disabled.' }
    const approved = true
    const result = await toolPressKey(args.key)
    await appendAuditEntry({
      ts: new Date().toISOString(),
      tool: 'keyboard_key',
      args: { key: args.key },
      approved,
      result: (result.output ?? result.error ?? '').slice(0, 200)
    })
    return { success: approved, error: approved ? undefined : 'User denied.' }
  })
}

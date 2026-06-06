import { vi, describe, it, expect, beforeEach } from 'vitest'

const { mockHandlers, mockDialog } = vi.hoisted(() => {
  return {
    mockHandlers: new Map<string, Function>(),
    mockDialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 }))
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, cb: Function) => {
      mockHandlers.set(channel, cb)
    })
  },
  powerMonitor: {
    isOnBatteryPower: vi.fn(() => false)
  },
  dialog: mockDialog,
  desktopCapturer: {
    getSources: vi.fn(async () => [
      {
        thumbnail: {
          toPNG: vi.fn(() => Buffer.from('fake-png'))
        }
      }
    ])
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      size: { width: 1920, height: 1080 }
    }))
  },
  clipboard: {
    readText: vi.fn(() => 'mock-clipboard-content')
  },
  app: {
    getPath: vi.fn(() => '/mockPictures')
  }
}))

vi.mock('os', () => ({
  default: {
    platform: () => 'win32',
    arch: () => 'x64',
    hostname: () => 'test-host',
    cpus: () => [{}, {}, {}, {}],
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
    uptime: () => 3600,
    networkInterfaces: () => ({
      eth0: [{ internal: false, family: 'IPv4', address: '192.168.1.10' }]
    })
  }
}))

vi.mock('child_process', () => ({
  execFile: vi.fn((file, args, callback) => {
    const fakeStdout = `"chrome.exe","1234","Console","1","100,000 K"\n"node.exe","5678","Console","1","50,000 K"`
    callback(null, { stdout: fakeStdout })
  })
}))

vi.mock('fs', () => {
  return {
    promises: {
      writeFile: vi.fn(async () => {})
    }
  }
})

vi.mock('../logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

import registerSystem from '../system'

function getHandler(name: string): Function {
  const handler = mockHandlers.get(name)
  if (!handler) throw new Error(`Handler ${name} not registered`)
  return handler
}

describe('system handler', () => {
  beforeEach(() => {
    mockHandlers.clear()
    vi.clearAllMocks()
    registerSystem()
  })

  it('should return rich system info', async () => {
    const getInfoHandler = getHandler('system:get-info')
    const info = await getInfoHandler()
    expect(info.platform).toBe(process.platform)
    expect(info.hostname).toBe('test-host')
    expect(info.cpus).toBe(4)
    expect(info.totalMemGB).toBe(16)
    expect(info.freeMemGB).toBe(8)
    expect(info.uptimeHrs).toBe(1)
    expect(info.networkConnected).toBe(true)
    expect(info.topProcesses).toEqual([
      { name: 'chrome.exe', memMB: 98 },
      { name: 'node.exe', memMB: 49 }
    ])
  })

  it('should read clipboard text', async () => {
    const readClipboardHandler = getHandler('system:clipboard-read')
    const res = await readClipboardHandler()
    expect(res).toEqual({ success: true, text: 'mock-clipboard-content' })
  })

  it('should execute screenshot and save directly', async () => {
    const screenshotHandler = getHandler('system:screenshot')
    const res = await screenshotHandler()
    expect(res.success).toBe(true)
    expect(res.path).toContain('iris-')
  })
})

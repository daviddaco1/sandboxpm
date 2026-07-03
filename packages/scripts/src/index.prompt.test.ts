import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ScriptPrompt } from './index.js'
import type { TaggedScript, ScriptRunResult } from './index.js'
import { defaultRc } from '@sandboxpm/config'

// ScriptPrompt.promptOne/_promptWindowsContainerSwitch/_promptNativeFallback all go
// through inquirer.prompt(); openInspect() shells out to the `open` package. Neither
// is mocked in index.test.ts (that suite spies over the whole method instead), so this
// file exercises the real prompt bodies with both dependencies stubbed.
const { promptMock, openMock } = vi.hoisted(() => ({
  promptMock: vi.fn(),
  openMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: (_path: string, _args: string[], cb: (err: null) => void) => cb(null),
}))

vi.mock('inquirer', () => ({
  default: { prompt: promptMock },
}))

vi.mock('open', () => ({
  default: openMock,
}))

function makeScript(name: string, version: string, lifecycle: TaggedScript['lifecycle'] = 'postinstall'): TaggedScript {
  return {
    name,
    version,
    lifecycle,
    command: 'node install.js',
    inspectUrl: `https://unpkg.com/${name}@${version}/install.js`,
  }
}

beforeEach(() => {
  promptMock.mockReset()
  openMock.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── ScriptPrompt.promptOne ────────────────────────────────────────────────────

describe('ScriptPrompt.promptOne', () => {
  it('returns the chosen decision directly for a non-inspect choice', async () => {
    promptMock.mockResolvedValueOnce({ choice: 'skip' })
    const prompt = new ScriptPrompt(defaultRc(), null)

    const decision = await prompt.promptOne(makeScript('pkg', '1.0.0'))

    expect(decision).toBe('skip')
    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(openMock).not.toHaveBeenCalled()
  })

  it('opens the inspect URL and re-asks when the choice is "inspect"', async () => {
    promptMock
      .mockResolvedValueOnce({ choice: 'inspect' })
      .mockResolvedValueOnce({ choice: 'run' })
    const prompt = new ScriptPrompt(defaultRc(), null)
    const script = makeScript('pkg', '1.0.0')

    const decision = await prompt.promptOne(script)

    expect(decision).toBe('run')
    expect(promptMock).toHaveBeenCalledTimes(2)
    expect(openMock).toHaveBeenCalledWith(script.inspectUrl)
  })

  it('supports "whitelisted" and "blacklisted" as terminal choices too', async () => {
    promptMock.mockResolvedValueOnce({ choice: 'blacklisted' })
    const prompt = new ScriptPrompt(defaultRc(), null)

    const decision = await prompt.promptOne(makeScript('pkg', '1.0.0'))

    expect(decision).toBe('blacklisted')
  })
})

// ─── ScriptPrompt.openInspect ──────────────────────────────────────────────────

describe('ScriptPrompt.openInspect', () => {
  it('delegates to the "open" package', async () => {
    const prompt = new ScriptPrompt(defaultRc(), null)
    await prompt.openInspect('https://example.com/install.js')
    expect(openMock).toHaveBeenCalledWith('https://example.com/install.js')
  })
})

// ─── ScriptPrompt._promptWindowsContainerSwitch ────────────────────────────────

describe('ScriptPrompt._promptWindowsContainerSwitch', () => {
  function castPrompt(prompt: ScriptPrompt) {
    return prompt as unknown as { _promptWindowsContainerSwitch: (s: TaggedScript) => Promise<boolean> }
  }

  it('returns true when the user confirms the switch', async () => {
    promptMock.mockResolvedValueOnce({ confirm: true })
    const prompt = castPrompt(new ScriptPrompt(defaultRc(), null))

    const result = await prompt._promptWindowsContainerSwitch(makeScript('native-pkg', '1.0.0', 'install'))

    expect(result).toBe(true)
  })

  it('returns false when the user declines', async () => {
    promptMock.mockResolvedValueOnce({ confirm: false })
    const prompt = castPrompt(new ScriptPrompt(defaultRc(), null))

    const result = await prompt._promptWindowsContainerSwitch(makeScript('native-pkg', '1.0.0', 'install'))

    expect(result).toBe(false)
  })
})

// ─── ScriptPrompt._promptNativeFallback ────────────────────────────────────────

describe('ScriptPrompt._promptNativeFallback', () => {
  function castPrompt(prompt: ScriptPrompt) {
    return prompt as unknown as {
      _promptNativeFallback: (s: TaggedScript, r: ScriptRunResult) => Promise<boolean>
    }
  }

  it('short-circuits to false (no second prompt) when the first confirmation is declined', async () => {
    promptMock.mockResolvedValueOnce({ firstConfirm: false })
    const prompt = castPrompt(new ScriptPrompt(defaultRc(), null))

    const result = await prompt._promptNativeFallback(makeScript('pkg', '1.0.0'), {
      packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0,
    })

    expect(result).toBe(false)
    expect(promptMock).toHaveBeenCalledTimes(1)
  })

  it('returns true only once both confirmations succeed (sandbox-blocked reason)', async () => {
    promptMock
      .mockResolvedValueOnce({ firstConfirm: true })
      .mockResolvedValueOnce({ secondConfirm: true })
    const prompt = castPrompt(new ScriptPrompt(defaultRc(), null))

    const result = await prompt._promptNativeFallback(makeScript('pkg', '1.0.0'), {
      packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 1,
      sandboxReport: { networkConnections: [], blockedConnections: [], filesWritten: [], unexpectedActivity: [], status: 'blocked' },
    })

    expect(result).toBe(true)
    expect(promptMock).toHaveBeenCalledTimes(2)
  })

  it('returns false when the explicit-risk second confirmation is declined (incompatible-binary reason)', async () => {
    promptMock
      .mockResolvedValueOnce({ firstConfirm: true })
      .mockResolvedValueOnce({ secondConfirm: false })
    const prompt = castPrompt(new ScriptPrompt(defaultRc(), null))

    const result = await prompt._promptNativeFallback(makeScript('pkg', '1.0.0'), {
      packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0,
    })

    expect(result).toBe(false)
    expect(promptMock).toHaveBeenCalledTimes(2)
  })
})

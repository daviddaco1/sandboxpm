import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import { SandboxRunner } from './index.js'
import type { TaggedScript, ScriptRunResult } from './index.js'
import { defaultRc } from '@sandboxpm/config'

// runNative() spawns via node:child_process's spawn; _switchDockerEngine/_buildImageIfNeeded
// use execFile. Both need mocking here (unlike index.test.ts, which only needs execFile).
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: (_path: string, _args: string[], cb: (err: null) => void) => cb(null),
  spawn: spawnMock,
}))

// _findDockerCliPath's hardcoded Windows path never exists on the Linux CI runner, but
// pin it down explicitly (rather than relying on that absence) so these tests are
// deterministic on any dev machine, including ones with Docker Desktop actually installed.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, access: vi.fn().mockRejectedValue(new Error('ENOENT')) }
})

function makeScript(name: string, version: string, lifecycle: TaggedScript['lifecycle'] = 'postinstall'): TaggedScript {
  return {
    name,
    version,
    lifecycle,
    command: 'node install.js',
    inspectUrl: `https://unpkg.com/${name}@${version}/install.js`,
  }
}

function stubPlatform(value: NodeJS.Platform): () => void {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => Object.defineProperty(process, 'platform', orig)
}

function fakeChild() {
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  return {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => { listeners[event] = cb }),
    emit: (event: string, ...args: unknown[]) => listeners[event]?.(...args),
  }
}

// runNative does `await import('node:child_process')` before calling spawn() and
// attaching its 'close'/'error' listeners, so emitting synchronously right after
// calling runNative races ahead of that registration. Flush the microtask + one
// macrotask tick first so spawn() has actually run.
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

const noDocker = {} as unknown as import('dockerode').default

// ─── SandboxRunner.runNative ────────────────────────────────────────────────────

describe('SandboxRunner.runNative', () => {
  beforeEach(() => { spawnMock.mockReset() })

  it('spawns via /bin/sh on non-Windows and resolves exitCode from the "close" event', async () => {
    const restore = stubPlatform('linux')
    try {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)
      const runner = new SandboxRunner(noDocker, defaultRc())

      const resultPromise = runner.runNative(makeScript('pkg', '1.0.0'), '/fake/deps/pkg')
      await flush()
      child.emit('close', 0)
      const result = await resultPromise

      expect(result).toMatchObject({ packageId: 'pkg@1.0.0', decision: 'run', exitCode: 0, nativeRun: true })
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/sh', ['-c', 'node install.js'],
        expect.objectContaining({ cwd: '/fake/deps/pkg' }),
      )
    } finally { restore() }
  })

  it('spawns via cmd /S /C on Windows', async () => {
    const restore = stubPlatform('win32')
    try {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)
      const runner = new SandboxRunner(noDocker, defaultRc())

      const resultPromise = runner.runNative(makeScript('pkg', '1.0.0'), 'C:\\fake\\deps\\pkg')
      await flush()
      child.emit('close', 0)
      await resultPromise

      expect(spawnMock).toHaveBeenCalledWith('cmd', ['/S', '/C', 'node install.js'], expect.anything())
    } finally { restore() }
  })

  it('propagates a non-zero exit code and defaults a null code to 0', async () => {
    const restore = stubPlatform('linux')
    try {
      const child1 = fakeChild()
      spawnMock.mockReturnValueOnce(child1)
      const runner = new SandboxRunner(noDocker, defaultRc())

      const p1 = runner.runNative(makeScript('pkg', '1.0.0'), '/fake/deps/pkg')
      await flush()
      child1.emit('close', 7)
      expect((await p1).exitCode).toBe(7)

      const child2 = fakeChild()
      spawnMock.mockReturnValueOnce(child2)
      const p2 = runner.runNative(makeScript('pkg', '1.0.0'), '/fake/deps/pkg')
      await flush()
      child2.emit('close', null)
      expect((await p2).exitCode).toBe(0)
    } finally { restore() }
  })

  it('resolves with exitCode 1 and writes to stderr when spawn itself errors', async () => {
    const restore = stubPlatform('linux')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)
      const runner = new SandboxRunner(noDocker, defaultRc())

      const resultPromise = runner.runNative(makeScript('pkg', '1.0.0'), '/fake/deps/pkg')
      await flush()
      child.emit('error', new Error('spawn ENOENT'))
      const result = await resultPromise

      expect(result).toMatchObject({ exitCode: 1, nativeRun: true, decision: 'run' })
      expect(stderrSpy).toHaveBeenCalled()
    } finally { restore(); stderrSpy.mockRestore() }
  })

  it("adds the project root's node_modules/.bin to PATH when packageDir sits under node_modules/.sandboxpm", async () => {
    const restore = stubPlatform('linux')
    try {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)
      const runner = new SandboxRunner(noDocker, defaultRc())

      const packageDir = path.join('project', 'node_modules', '.sandboxpm', 'pkg@1.0.0', 'node_modules', 'pkg')
      const resultPromise = runner.runNative(makeScript('pkg', '1.0.0'), packageDir)
      await flush()
      child.emit('close', 0)
      await resultPromise

      const spawnOpts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> }
      expect(spawnOpts.env['PATH']).toContain(path.join('project', 'node_modules', '.bin'))
    } finally { restore() }
  })
})

// ─── SandboxRunner.isNativeFallbackCandidate / _hasIncompatibleNatives ─────────

describe('SandboxRunner.isNativeFallbackCandidate', () => {
  it('is true whenever the sandbox report status is blocked', async () => {
    const runner = new SandboxRunner(noDocker, defaultRc())
    const result: ScriptRunResult = {
      packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 1,
      sandboxReport: { networkConnections: [], blockedConnections: [], filesWritten: [], unexpectedActivity: [], status: 'blocked' },
    }
    expect(await runner.isNativeFallbackCandidate(result, '/fake/pkg')).toBe(true)
  })

  it('is false on a clean successful run with no native addons', async () => {
    const restore = stubPlatform('darwin')
    try {
      const { mkdtemp, rm } = await import('fs/promises')
      const { tmpdir } = await import('os')
      const dir = await mkdtemp(path.join(tmpdir(), 'sandboxpm-native-test-'))
      try {
        const runner = new SandboxRunner(noDocker, defaultRc())
        const result: ScriptRunResult = { packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0 }
        expect(await runner.isNativeFallbackCandidate(result, dir)).toBe(false)
      } finally { await rm(dir, { recursive: true, force: true }) }
    } finally { restore() }
  })

  it('is true when a successful run produced a Linux ELF .node addon on a non-Linux host', async () => {
    const restore = stubPlatform('darwin')
    try {
      const { mkdtemp, rm, writeFile } = await import('fs/promises')
      const { tmpdir } = await import('os')
      const dir = await mkdtemp(path.join(tmpdir(), 'sandboxpm-native-test-'))
      try {
        await writeFile(path.join(dir, 'addon.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]))
        const runner = new SandboxRunner(noDocker, defaultRc())
        const result: ScriptRunResult = { packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0 }
        expect(await runner.isNativeFallbackCandidate(result, dir)).toBe(true)
      } finally { await rm(dir, { recursive: true, force: true }) }
    } finally { restore() }
  })

  it('never flags ELF addons on a Linux host (they are native there)', async () => {
    const restore = stubPlatform('linux')
    try {
      const { mkdtemp, rm, writeFile } = await import('fs/promises')
      const { tmpdir } = await import('os')
      const dir = await mkdtemp(path.join(tmpdir(), 'sandboxpm-native-test-'))
      try {
        await writeFile(path.join(dir, 'addon.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        const runner = new SandboxRunner(noDocker, defaultRc())
        const result: ScriptRunResult = { packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0 }
        expect(await runner.isNativeFallbackCandidate(result, dir)).toBe(false)
      } finally { await rm(dir, { recursive: true, force: true }) }
    } finally { restore() }
  })

  it('does not descend into nested node_modules while scanning for addons', async () => {
    const restore = stubPlatform('darwin')
    try {
      const { mkdtemp, rm, writeFile, mkdir } = await import('fs/promises')
      const { tmpdir } = await import('os')
      const dir = await mkdtemp(path.join(tmpdir(), 'sandboxpm-native-test-'))
      try {
        const nested = path.join(dir, 'node_modules', 'sub')
        await mkdir(nested, { recursive: true })
        await writeFile(path.join(nested, 'addon.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        const runner = new SandboxRunner(noDocker, defaultRc())
        const result: ScriptRunResult = { packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0 }
        expect(await runner.isNativeFallbackCandidate(result, dir)).toBe(false)
      } finally { await rm(dir, { recursive: true, force: true }) }
    } finally { restore() }
  })

  it('is false when exitCode is non-zero and the sandbox report is not blocked', async () => {
    const runner = new SandboxRunner(noDocker, defaultRc())
    const result: ScriptRunResult = { packageId: 'pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 1 }
    expect(await runner.isNativeFallbackCandidate(result, '/fake/pkg')).toBe(false)
  })
})

// ─── SandboxRunner.canOfferWindowsContainerRebuild ─────────────────────────────

describe('SandboxRunner.canOfferWindowsContainerRebuild', () => {
  it('is false on a non-Windows host', async () => {
    const restore = stubPlatform('linux')
    try {
      const runner = new SandboxRunner(noDocker, defaultRc())
      expect(await runner.canOfferWindowsContainerRebuild()).toBe(false)
    } finally { restore() }
  })

  it('is false when the daemon is already running Windows containers', async () => {
    const restore = stubPlatform('win32')
    try {
      const fakeDocker = { info: vi.fn().mockResolvedValue({ OSType: 'windows' }) } as unknown as import('dockerode').default
      const runner = new SandboxRunner(fakeDocker, defaultRc())
      expect(await runner.canOfferWindowsContainerRebuild()).toBe(false)
    } finally { restore() }
  })

  it('is false when DockerCli.exe cannot be found', async () => {
    const restore = stubPlatform('win32')
    try {
      const fakeDocker = { info: vi.fn().mockResolvedValue({ OSType: 'linux' }) } as unknown as import('dockerode').default
      const runner = new SandboxRunner(fakeDocker, defaultRc())
      expect(await runner.canOfferWindowsContainerRebuild()).toBe(false)
    } finally { restore() }
  })

  it('is true when Windows, the daemon is Linux-mode, and DockerCli.exe is found', async () => {
    const restore = stubPlatform('win32')
    try {
      const fakeDocker = { info: vi.fn().mockResolvedValue({ OSType: 'linux' }) } as unknown as import('dockerode').default
      const runner = new SandboxRunner(fakeDocker, defaultRc())
      vi.spyOn(runner as unknown as { _findDockerCliPath: () => Promise<string | undefined> }, '_findDockerCliPath')
        .mockResolvedValue('C:\\fake\\DockerCli.exe')
      expect(await runner.canOfferWindowsContainerRebuild()).toBe(true)
    } finally { restore() }
  })
})

// ─── SandboxRunner._switchDockerEngine — success / timeout / unavailable ───────

describe('SandboxRunner._switchDockerEngine', () => {
  function castRunner(runner: SandboxRunner) {
    return runner as unknown as { _switchDockerEngine: (t: string) => Promise<{ ok: boolean; reason?: string }> }
  }

  it('resolves ok:true once docker info reports the target OSType', async () => {
    vi.useFakeTimers()
    try {
      const infoMock = vi.fn()
        .mockResolvedValueOnce({ OSType: 'linux' })
        .mockResolvedValue({ OSType: 'windows' })
      const fakeDocker = { info: infoMock } as unknown as import('dockerode').default
      const runner = new SandboxRunner(fakeDocker, defaultRc())
      vi.spyOn(runner as unknown as { _findDockerCliPath: () => Promise<string | undefined> }, '_findDockerCliPath')
        .mockResolvedValue('C:\\fake\\DockerCli.exe')

      const switchPromise = castRunner(runner)._switchDockerEngine('windows')

      await vi.advanceTimersByTimeAsync(3_000)
      await vi.advanceTimersByTimeAsync(3_000)
      const result = await switchPromise

      expect(result).toEqual({ ok: true })
    } finally { vi.useRealTimers() }
  })

  it('resolves ok:false reason:timeout when the daemon never reports the target OSType', async () => {
    vi.useFakeTimers()
    try {
      const fakeDocker = { info: vi.fn().mockResolvedValue({ OSType: 'linux' }) } as unknown as import('dockerode').default
      const runner = new SandboxRunner(fakeDocker, defaultRc())
      vi.spyOn(runner as unknown as { _findDockerCliPath: () => Promise<string | undefined> }, '_findDockerCliPath')
        .mockResolvedValue('C:\\fake\\DockerCli.exe')

      const switchPromise = castRunner(runner)._switchDockerEngine('windows')

      await vi.advanceTimersByTimeAsync(125_000) // past the 120s deadline
      const result = await switchPromise

      expect(result).toEqual({ ok: false, reason: 'timeout' })
    } finally { vi.useRealTimers() }
  })

  it('resolves ok:false reason:unavailable when DockerCli.exe is not installed', async () => {
    const runner = new SandboxRunner(noDocker, defaultRc())
    const result = await castRunner(runner)._switchDockerEngine('windows')
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })
})

// ─── SandboxRunner.restoreDockerEngine — successful switch back ───────────────

describe('SandboxRunner.restoreDockerEngine', () => {
  it('does not log an error when the switch back to Linux succeeds', async () => {
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: vi.fn().mockImplementation(async () => ({
        attach: vi.fn().mockResolvedValue({}),
        start: vi.fn(),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        modem: { demuxStream: vi.fn() },
      })),
    } as unknown as import('dockerode').default
    const runner = new SandboxRunner(fakeDocker, defaultRc())
    vi.spyOn(
      runner as unknown as { _switchDockerEngine: (t: string) => Promise<{ ok: boolean; reason?: string }> },
      '_switchDockerEngine',
    ).mockResolvedValue({ ok: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runner.runInWindowsContainer(makeScript('pkg', '1.0.0', 'install'), '')
    await runner.restoreDockerEngine()

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

// ─── SandboxRunner._windowsSwitchFailureMessage ────────────────────────────────

describe('SandboxRunner._windowsSwitchFailureMessage', () => {
  function call(runner: SandboxRunner, reason: 'feature-disabled' | 'unavailable' | 'timeout' | undefined) {
    return (runner as unknown as { _windowsSwitchFailureMessage: (r: typeof reason) => string })
      ._windowsSwitchFailureMessage(reason)
  }

  it('describes the disabled-feature remediation', () => {
    const runner = new SandboxRunner(noDocker, defaultRc())
    expect(call(runner, 'feature-disabled')).toContain('Enable-WindowsOptionalFeature')
  })

  it('describes a missing DockerCli.exe', () => {
    const runner = new SandboxRunner(noDocker, defaultRc())
    expect(call(runner, 'unavailable')).toContain('DockerCli.exe not found')
  })

  it('falls back to a generic timeout message for "timeout" and undefined', () => {
    const runner = new SandboxRunner(noDocker, defaultRc())
    expect(call(runner, 'timeout')).toContain('Timed out')
    expect(call(runner, undefined)).toContain('Timed out')
  })
})

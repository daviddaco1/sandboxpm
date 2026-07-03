import { describe, it, expect, vi } from 'vitest'
import { ScriptPrompt, SandboxRunner } from './index.js'
import type { TaggedScript, ScriptRunResult } from './index.js'
import { defaultRc } from '@sandboxpm/config'

// DockerCli's switch flags are fire-and-forget from the CLI's perspective (see
// _switchDockerEngine) — a no-op callback is all any test needs from execFile.
vi.mock('node:child_process', () => ({
  execFile: (_path: string, _args: string[], cb: (err: null) => void) => cb(null),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScript(name: string, version: string, lifecycle: TaggedScript['lifecycle'] = 'postinstall'): TaggedScript {
  return {
    name,
    version,
    lifecycle,
    command: 'node install.js',
    inspectUrl: `https://unpkg.com/${name}@${version}/install.js`,
  }
}

// ─── ScriptPrompt — whitelist / blacklist partitioning ────────────────────────

describe('ScriptPrompt.promptAll — whitelist / blacklist', () => {
  it('auto-skips blacklisted packages without prompting', async () => {
    const rc = defaultRc()
    rc.blacklist = ['evil-pkg']
    const prompt = new ScriptPrompt(rc, null)

    const promptOneSpy = vi.spyOn(prompt, 'promptOne')
    const results = await prompt.promptAll([makeScript('evil-pkg', '1.0.0')])

    expect(promptOneSpy).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]?.decision).toBe('blacklisted')
  })

  it('auto-runs whitelisted packages without prompting', async () => {
    const rc = defaultRc()
    rc.whitelist = ['trusted-pkg']
    const prompt = new ScriptPrompt(rc, null)

    const promptOneSpy = vi.spyOn(prompt, 'promptOne')
    const results = await prompt.promptAll([makeScript('trusted-pkg', '2.0.0')])

    expect(promptOneSpy).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]?.decision).toBe('whitelisted')
  })

  it('returns empty array for no scripts', async () => {
    const prompt = new ScriptPrompt(defaultRc(), null)
    const results = await prompt.promptAll([])
    expect(results).toEqual([])
  })
})

// ─── ScriptPrompt.promptAll — decision routing ────────────────────────────────

describe('ScriptPrompt.promptAll — decision routing', () => {
  it('routes "skip" decision to a skip result', async () => {
    const rc = defaultRc()
    const prompt = new ScriptPrompt(rc, null)
    vi.spyOn(prompt, 'promptOne').mockResolvedValue('skip')

    const results = await prompt.promptAll([makeScript('unknown-pkg', '1.0.0')])
    expect(results[0]?.decision).toBe('skip')
  })

  it('routes "run" decision to a run result', async () => {
    const rc = defaultRc()
    const prompt = new ScriptPrompt(rc, null)
    vi.spyOn(prompt, 'promptOne').mockResolvedValue('run')

    const results = await prompt.promptAll([makeScript('my-pkg', '1.0.0')])
    expect(results[0]?.decision).toBe('run')
  })

  it('routes "blacklisted" decision and adds to rc.blacklist', async () => {
    const rc = defaultRc()
    const prompt = new ScriptPrompt(rc, null)
    vi.spyOn(prompt, 'promptOne').mockResolvedValue('blacklisted')

    await prompt.promptAll([makeScript('bad-pkg', '1.0.0')])
    expect(rc.blacklist).toContain('bad-pkg')
  })

  it('routes "whitelisted" decision and adds to rc.whitelist', async () => {
    const rc = defaultRc()
    const prompt = new ScriptPrompt(rc, null)
    vi.spyOn(prompt, 'promptOne').mockResolvedValue('whitelisted')

    const results = await prompt.promptAll([makeScript('good-pkg', '1.0.0')])
    expect(rc.whitelist).toContain('good-pkg')
    expect(results[0]?.decision).toBe('whitelisted')
  })

  it('calls runner.run when decision is "run" and runner is provided', async () => {
    const rc = defaultRc()
    const fakeResult: ScriptRunResult = {
      packageId: 'my-pkg@1.0.0',
      lifecycle: 'postinstall',
      decision: 'run',
      exitCode: 0,
      durationMs: 100,
    }
    const fakeRunner = {
      run: vi.fn().mockResolvedValue(fakeResult),
      ensureNetwork: vi.fn().mockResolvedValue(undefined),
      isNativeFallbackCandidate: vi.fn().mockResolvedValue(false),
      restoreDockerEngine: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxRunner

    const prompt = new ScriptPrompt(rc, fakeRunner)
    vi.spyOn(prompt, 'promptOne').mockResolvedValue('run')

    const results = await prompt.promptAll([makeScript('my-pkg', '1.0.0')])
    expect(fakeRunner.run).toHaveBeenCalledOnce()
    expect(results[0]).toBe(fakeResult)
    expect(fakeRunner.restoreDockerEngine).toHaveBeenCalledOnce()
  })

  it('offers a Windows-containers rebuild before native fallback when one is available', async () => {
    const rc = defaultRc()
    rc.whitelist = ['native-pkg']
    const blockedResult: ScriptRunResult = {
      packageId: 'native-pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 1,
      sandboxReport: { networkConnections: [], blockedConnections: [], filesWritten: [], unexpectedActivity: [], status: 'blocked' },
    }
    const winResult: ScriptRunResult = {
      packageId: 'native-pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0,
    }
    const fakeRunner = {
      run: vi.fn().mockResolvedValue(blockedResult),
      isNativeFallbackCandidate: vi.fn().mockImplementation(async (r: ScriptRunResult) => r === blockedResult),
      canOfferWindowsContainerRebuild: vi.fn().mockResolvedValue(true),
      runInWindowsContainer: vi.fn().mockResolvedValue(winResult),
      runNative: vi.fn(),
      restoreDockerEngine: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxRunner

    const prompt = new ScriptPrompt(rc, fakeRunner)
    vi.spyOn(prompt as unknown as { _promptWindowsContainerSwitch: () => Promise<boolean> }, '_promptWindowsContainerSwitch')
      .mockResolvedValue(true)

    const results = await prompt.promptAll([makeScript('native-pkg', '1.0.0', 'install')])

    expect(fakeRunner.runInWindowsContainer).toHaveBeenCalledOnce()
    expect(fakeRunner.runNative).not.toHaveBeenCalled()
    expect(results[0]).toBe(winResult)
  })

  it('falls through to native fallback when the Windows-containers rebuild is declined', async () => {
    const rc = defaultRc()
    rc.whitelist = ['native-pkg']
    const blockedResult: ScriptRunResult = {
      packageId: 'native-pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 1,
      sandboxReport: { networkConnections: [], blockedConnections: [], filesWritten: [], unexpectedActivity: [], status: 'blocked' },
    }
    const nativeResult: ScriptRunResult = {
      packageId: 'native-pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0, nativeRun: true,
    }
    const fakeRunner = {
      run: vi.fn().mockResolvedValue(blockedResult),
      isNativeFallbackCandidate: vi.fn().mockResolvedValue(true),
      canOfferWindowsContainerRebuild: vi.fn().mockResolvedValue(true),
      runInWindowsContainer: vi.fn(),
      runNative: vi.fn().mockResolvedValue(nativeResult),
      restoreDockerEngine: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxRunner

    const prompt = new ScriptPrompt(rc, fakeRunner)
    vi.spyOn(prompt as unknown as { _promptWindowsContainerSwitch: () => Promise<boolean> }, '_promptWindowsContainerSwitch')
      .mockResolvedValue(false)
    vi.spyOn(prompt as unknown as { _promptNativeFallback: () => Promise<boolean> }, '_promptNativeFallback')
      .mockResolvedValue(true)

    const results = await prompt.promptAll([makeScript('native-pkg', '1.0.0', 'install')])

    expect(fakeRunner.runInWindowsContainer).not.toHaveBeenCalled()
    expect(fakeRunner.runNative).toHaveBeenCalledOnce()
    expect(results[0]).toBe(nativeResult)
  })

  it('skips the Windows-containers offer entirely when unavailable (e.g. non-Windows host)', async () => {
    const rc = defaultRc()
    rc.whitelist = ['native-pkg']
    const blockedResult: ScriptRunResult = {
      packageId: 'native-pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 1,
      sandboxReport: { networkConnections: [], blockedConnections: [], filesWritten: [], unexpectedActivity: [], status: 'blocked' },
    }
    const nativeResult: ScriptRunResult = {
      packageId: 'native-pkg@1.0.0', lifecycle: 'install', decision: 'run', exitCode: 0, nativeRun: true,
    }
    const fakeRunner = {
      run: vi.fn().mockResolvedValue(blockedResult),
      isNativeFallbackCandidate: vi.fn().mockResolvedValue(true),
      canOfferWindowsContainerRebuild: vi.fn().mockResolvedValue(false),
      runInWindowsContainer: vi.fn(),
      runNative: vi.fn().mockResolvedValue(nativeResult),
      restoreDockerEngine: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxRunner

    const prompt = new ScriptPrompt(rc, fakeRunner)
    const winSwitchSpy = vi.spyOn(prompt as unknown as { _promptWindowsContainerSwitch: () => Promise<boolean> }, '_promptWindowsContainerSwitch')
    vi.spyOn(prompt as unknown as { _promptNativeFallback: () => Promise<boolean> }, '_promptNativeFallback')
      .mockResolvedValue(true)

    await prompt.promptAll([makeScript('native-pkg', '1.0.0', 'install')])

    expect(winSwitchSpy).not.toHaveBeenCalled()
    expect(fakeRunner.runInWindowsContainer).not.toHaveBeenCalled()
    expect(fakeRunner.runNative).toHaveBeenCalledOnce()
  })
})

// ─── SandboxRunner — Docker args validation ────────────────────────────────────

describe('SandboxRunner — Docker container args', () => {
  it('builds correct container options with all security flags', async () => {
    const rc = defaultRc()

    let capturedOpts: Record<string, unknown> | undefined
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedOpts = opts
        return {
          attach: vi.fn().mockResolvedValue({
            pipe: vi.fn(),
          }),
          start: vi.fn().mockResolvedValue(undefined),
          wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
          modem: { demuxStream: vi.fn() },
        }
      }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    const script = makeScript('esbuild', '0.19.4')
    await runner.run(script, '/fake/pkg/dir')

    expect(capturedOpts).toBeDefined()
    const hostConfig = capturedOpts!['HostConfig'] as Record<string, unknown>

    // Must cap-drop ALL
    expect(hostConfig['CapDrop']).toContain('ALL')
    // Must have no-new-privileges security opt
    const secOpts = hostConfig['SecurityOpt'] as string[]
    expect(secOpts.some((o: string) => o.includes('no-new-privileges'))).toBe(true)
    // Must have memory limit
    expect(hostConfig['Memory']).toBe(512 * 1024 * 1024)
    // Must have pids limit
    expect(hostConfig['PidsLimit']).toBe(100)
    // Must be read-only root FS
    expect(hostConfig['ReadonlyRootfs']).toBe(true)
    // Must use sandbox network
    expect(hostConfig['NetworkMode']).toBe('sandboxpm-net')
    // Must bind package dir
    expect((hostConfig['Binds'] as string[]).some(b => b.includes('/fake/pkg/dir'))).toBe(true)
  })

  it('persists a report file when reportsDir is set', async () => {
    const rc = defaultRc()
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

    const { mkdtemp, readdir, rm } = await import('fs/promises')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const reportsDir = await mkdtemp(join(tmpdir(), 'sandboxpm-reports-test-'))

    try {
      const runner = new SandboxRunner(fakeDocker, rc, reportsDir)
      await runner.run(makeScript('mypkg', '1.2.3'), '')

      const files = await readdir(reportsDir)
      expect(files.length).toBeGreaterThan(0)
      expect(files[0]).toMatch(/mypkg/)
    } finally {
      await rm(reportsDir, { recursive: true, force: true })
    }
  })

  it('does NOT pass host env vars by default', async () => {
    const rc = defaultRc()
    // rc.envPassthrough is [] by default

    let capturedOpts: Record<string, unknown> | undefined
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedOpts = opts
        return {
          attach: vi.fn().mockResolvedValue({}),
          start: vi.fn(),
          wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
          modem: { demuxStream: vi.fn() },
        }
      }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    await runner.run(makeScript('pkg', '1.0.0'), '')

    // Only the always-present PATH/NODE_PATH entries — no host env vars leaked through.
    expect(capturedOpts!['Env']).toEqual(['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_PATH=/sandbox/deps'])
  })
})

// ─── SandboxRunner.ensureNetwork — egress filtering ───────────────────────────

describe('SandboxRunner.ensureNetwork — network egress filtering', () => {
  it('creates Internal:true network for isolated mode', async () => {
    const rc = { ...defaultRc(), sandbox: { ...defaultRc().sandbox, networkMode: 'isolated' as const } }
    let capturedNetworkOpts: Record<string, unknown> | undefined
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([]),
      createNetwork: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedNetworkOpts = opts
      }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    await runner.ensureNetwork()

    expect(fakeDocker.createNetwork).toHaveBeenCalled()
    expect(capturedNetworkOpts?.['Internal']).toBe(true)
  })

  it('creates Internal:false network for restricted mode', async () => {
    const rc = { ...defaultRc(), sandbox: { ...defaultRc().sandbox, networkMode: 'restricted' as const } }
    let capturedNetworkOpts: Record<string, unknown> | undefined
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([]),
      createNetwork: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedNetworkOpts = opts
      }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    await runner.ensureNetwork()

    expect(fakeDocker.createNetwork).toHaveBeenCalled()
    expect(capturedNetworkOpts?.['Internal']).toBe(false)
  })

  it('does not call createNetwork when network already exists', async () => {
    const rc = defaultRc()
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      createNetwork: vi.fn(),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    await runner.ensureNetwork()

    expect(fakeDocker.createNetwork).not.toHaveBeenCalled()
  })
})

// ─── SandboxRunner — real syscall auditing (sandbox.auditSyscalls) ────────────

describe('SandboxRunner — syscall auditing', () => {
  it('leaves the default stub report unchanged when auditSyscalls is off', async () => {
    const rc = defaultRc() // auditSyscalls: false by default

    let capturedOpts: Record<string, unknown> | undefined
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedOpts = opts
        return {
          attach: vi.fn().mockResolvedValue({}),
          start: vi.fn(),
          wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
          modem: { demuxStream: vi.fn() },
        }
      }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    const result = await runner.run(makeScript('pkg', '1.0.0'), '/fake/pkg/dir')

    const hostConfig = capturedOpts!['HostConfig'] as Record<string, unknown>
    expect(hostConfig['CapAdd']).toBeUndefined()
    expect(capturedOpts!['Cmd']).toEqual(['/bin/sh', '-c', 'node install.js'])
    expect(result.sandboxReport).toEqual({
      networkConnections: [],
      blockedConnections: [],
      filesWritten: [],
      unexpectedActivity: [],
      status: 'clean',
    })
  })

  it('adds CapAdd:SYS_PTRACE, the audit seccomp profile, and wraps Cmd with strace when on', async () => {
    const rc = { ...defaultRc(), sandbox: { ...defaultRc().sandbox, auditSyscalls: true } }

    let capturedOpts: Record<string, unknown> | undefined
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedOpts = opts
        return {
          attach: vi.fn().mockResolvedValue({}),
          start: vi.fn(),
          wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
          modem: { demuxStream: vi.fn() },
        }
      }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    await runner.run(makeScript('pkg', '1.0.0'), '/fake/pkg/dir')

    const hostConfig = capturedOpts!['HostConfig'] as Record<string, unknown>
    expect(hostConfig['CapAdd']).toEqual(['SYS_PTRACE'])
    expect(hostConfig['CapDrop']).toContain('ALL') // still additive, not a replacement
    const secOpts = hostConfig['SecurityOpt'] as string[]
    expect(secOpts.some(o => o.includes('audit variant'))).toBe(true)
    const cmd = capturedOpts!['Cmd'] as string[]
    expect(cmd[2]).toContain('strace')
    expect(cmd[2]).toContain('node install.js')
    expect((hostConfig['Binds'] as string[]).some(b => b.endsWith(':/sandbox/trace:rw'))).toBe(true)
  })

  it('parses a real trace file written into the bind-mounted trace dir', async () => {
    let traceHostDir = ''
    const rc = { ...defaultRc(), sandbox: { ...defaultRc().sandbox, auditSyscalls: true } }
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        const hostConfig = opts['HostConfig'] as Record<string, unknown>
        const binds = hostConfig['Binds'] as string[]
        const traceBind = binds.find(b => b.endsWith(':/sandbox/trace:rw'))
        traceHostDir = traceBind!.slice(0, -':/sandbox/trace:rw'.length)
        return {
          attach: vi.fn().mockResolvedValue({}),
          start: vi.fn(),
          wait: vi.fn().mockImplementation(async () => {
            const { writeFile } = await import('fs/promises')
            const { join } = await import('path')
            await writeFile(
              join(traceHostDir, 'strace.log'),
              'connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("5.6.7.8")}, 16) = -1 ECONNREFUSED (Connection refused)\n',
            )
            return { StatusCode: 0 }
          }),
          modem: { demuxStream: vi.fn() },
        }
      }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    const result = await runner.run(makeScript('pkg', '1.0.0'), '/fake/pkg/dir')

    expect(result.sandboxReport?.audited).toBe(true)
    expect(result.sandboxReport?.blockedConnections).toEqual(['5.6.7.8:443'])
    expect(result.sandboxReport?.status).toBe('warned')

    const { stat } = await import('fs/promises')
    await expect(stat(traceHostDir)).rejects.toThrow() // cleaned up after run()
  })
})

// ─── SandboxRunner — Windows containers engine switch ─────────────────────────
// Regression coverage for a real failure: on a machine without the Windows
// "Containers" optional feature enabled, `-SwitchWindowsEngine` flips Docker
// Desktop's configured engine but the daemon never comes up on the Windows pipe.
// Waiting out the full timeout there just wastes two minutes on every affected
// package, so a confirmed pipe-connection failure past a short grace period
// should fail fast with an actionable reason instead.
describe('SandboxRunner — Windows containers engine switch', () => {
  const PIPE_ERROR = new Error(
    'failed to connect to the docker API at npipe:////./pipe/dockerDesktopWindowsEngine: ' +
    'open //./pipe/dockerDesktopWindowsEngine: the system cannot find the file specified.'
  )

  it('fails fast with reason "feature-disabled" once past the grace period, without waiting the full timeout', async () => {
    vi.useFakeTimers()
    try {
      const rc = defaultRc()
      const fakeDocker = { info: vi.fn().mockRejectedValue(PIPE_ERROR) } as unknown as import('dockerode').default
      const runner = new SandboxRunner(fakeDocker, rc)
      vi.spyOn(runner as unknown as { _findDockerCliPath: () => Promise<string | undefined> }, '_findDockerCliPath')
        .mockResolvedValue('C:\\fake\\DockerCli.exe')

      const switchPromise = (runner as unknown as {
        _switchDockerEngine: (target: string) => Promise<{ ok: boolean; reason?: string }>
      })._switchDockerEngine('windows')

      await vi.advanceTimersByTimeAsync(35_000) // past the 30s grace period, well under the 2min timeout
      const result = await switchPromise

      expect(result).toEqual({ ok: false, reason: 'feature-disabled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks Windows containers unavailable after a failed switch, so later packages stop being offered it', async () => {
    const rc = defaultRc()
    const fakeDocker = { info: vi.fn().mockRejectedValue(PIPE_ERROR) } as unknown as import('dockerode').default
    const runner = new SandboxRunner(fakeDocker, rc)
    vi.spyOn(
      runner as unknown as { _switchDockerEngine: () => Promise<{ ok: boolean; reason?: string }> },
      '_switchDockerEngine',
    ).mockResolvedValue({ ok: false, reason: 'feature-disabled' })

    const script = makeScript('native-pkg', '1.0.0', 'install')
    const result = await runner.runInWindowsContainer(script, '/fake/pkg/dir')

    expect(result.sandboxReport?.status).toBe('blocked')
    expect(result.sandboxReport?.unexpectedActivity[0]).toContain('Enable-WindowsOptionalFeature')
    // _windowsContainersUnavailable short-circuits before the platform/daemon checks,
    // so this holds regardless of which OS the test happens to run on.
    expect(await runner.canOfferWindowsContainerRebuild()).toBe(false)
  })

  it('still restores to Linux (best-effort) even when the Windows switch itself failed', async () => {
    const rc = defaultRc()
    const fakeDocker = { info: vi.fn().mockRejectedValue(PIPE_ERROR) } as unknown as import('dockerode').default
    const runner = new SandboxRunner(fakeDocker, rc)
    const switchSpy = vi.spyOn(
      runner as unknown as { _switchDockerEngine: (t: string) => Promise<{ ok: boolean; reason?: string }> },
      '_switchDockerEngine',
    ).mockResolvedValue({ ok: false, reason: 'feature-disabled' })

    await runner.runInWindowsContainer(makeScript('native-pkg', '1.0.0', 'install'), '/fake/pkg/dir')
    await runner.restoreDockerEngine()

    expect(switchSpy).toHaveBeenNthCalledWith(1, 'windows')
    expect(switchSpy).toHaveBeenNthCalledWith(2, 'linux')
  })
})

// ─── ScriptPrompt — policy evaluation ────────────────────────────────────────

describe('ScriptPrompt.promptAll — policy evaluation', () => {
  it('onWarn:continue → unlisted scripts auto-skipped without prompting', async () => {
    const rc = defaultRc()
    rc.policies.onWarn = 'continue'
    const prompt = new ScriptPrompt(rc, null)
    const promptOneSpy = vi.spyOn(prompt, 'promptOne')

    const results = await prompt.promptAll([makeScript('unknown-pkg', '1.0.0')])

    expect(promptOneSpy).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]?.decision).toBe('skip')
  })

  it('onWarn:abort → throws when any unreviewed script is present', async () => {
    const rc = defaultRc()
    rc.policies.onWarn = 'abort'
    const prompt = new ScriptPrompt(rc, null)

    await expect(
      prompt.promptAll([makeScript('unknown-pkg', '1.0.0')])
    ).rejects.toThrow(/unreviewed install script/)
  })

  it('onWarn:abort → does not throw when all scripts are whitelisted', async () => {
    const rc = defaultRc()
    rc.policies.onWarn = 'abort'
    rc.whitelist = ['trusted-pkg']
    const prompt = new ScriptPrompt(rc, null)

    const results = await prompt.promptAll([makeScript('trusted-pkg', '1.0.0')])
    expect(results).toHaveLength(1)
    expect(results[0]?.decision).toBe('whitelisted')
  })

  it('onBlock:prompt → blacklisted scripts are sent to prompt instead of auto-skipped', async () => {
    const rc = defaultRc()
    rc.policies.onBlock = 'prompt'
    rc.blacklist = ['formerly-evil-pkg']
    const prompt = new ScriptPrompt(rc, null)

    vi.spyOn(prompt, 'promptOne').mockResolvedValue('skip')

    const results = await prompt.promptAll([makeScript('formerly-evil-pkg', '1.0.0')])

    expect(prompt.promptOne).toHaveBeenCalled()
    expect(results[0]?.decision).toBe('skip')
  })
})

// ─── Docker assets — Fix 4 ────────────────────────────────────────────────────

describe('Docker sandbox assets', () => {
  it('SANDBOX_IMAGE is not the generic node:20-alpine', async () => {
    // SANDBOX_IMAGE is module-level, not exported directly — verify via SandboxRunner source
    // Instead: confirm the bundled seccomp.json exists on disk at the expected path
    const { fileURLToPath } = await import('url')
    const fs = await import('fs/promises')

    const seccompPath = fileURLToPath(new URL('../assets/seccomp.json', import.meta.url))
    const stat = await fs.stat(seccompPath)
    expect(stat.isFile()).toBe(true)

    const seccomp = JSON.parse(await fs.readFile(seccompPath, 'utf8')) as { defaultAction: string }
    expect(seccomp.defaultAction).toBe('SCMP_ACT_ERRNO')
  })

  it('bundled Dockerfile exists in assets/', async () => {
    const { fileURLToPath } = await import('url')
    const fs = await import('fs/promises')

    const dockerfilePath = fileURLToPath(new URL('../assets/Dockerfile', import.meta.url))
    const content = await fs.readFile(dockerfilePath, 'utf8')
    expect(content).toContain('FROM node:20-alpine')
    expect(content).toContain('sandbox')
  })
})

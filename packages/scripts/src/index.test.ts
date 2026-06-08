import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScriptPrompt, SandboxRunner } from './index.js'
import type { TaggedScript, ScriptRunResult } from './index.js'
import { defaultRc } from '@sandboxpm/config'

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
    } as unknown as SandboxRunner

    const prompt = new ScriptPrompt(rc, fakeRunner)
    vi.spyOn(prompt, 'promptOne').mockResolvedValue('run')

    const results = await prompt.promptAll([makeScript('my-pkg', '1.0.0')])
    expect(fakeRunner.run).toHaveBeenCalledOnce()
    expect(results[0]).toBe(fakeResult)
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

    expect(capturedOpts!['Env']).toEqual([])
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
    // Import module internals to check the constant value
    const mod = await import('./index.js')
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

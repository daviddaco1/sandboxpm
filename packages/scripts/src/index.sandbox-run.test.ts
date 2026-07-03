import { describe, it, expect, vi } from 'vitest'
import { SandboxRunner } from './index.js'
import type { TaggedScript } from './index.js'
import { defaultRc } from '@sandboxpm/config'

// _buildImageIfNeeded and _switchDockerEngine shell out via execFile — see
// index.test.ts for the rationale behind this fire-and-forget mock.
vi.mock('node:child_process', () => ({
  execFile: (_path: string, _args: string[], cb: (err: null) => void) => cb(null),
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

// run()'s isWin branch is decided by `_isWindowsDaemon()`, which short-circuits to
// false on any non-win32 host. CI runs on ubuntu-latest, so the Windows-container
// option-building code (`_buildWindowsOpts`) is otherwise unreachable there — stub
// process.platform to exercise it regardless of the actual host OS.
function stubPlatform(value: NodeJS.Platform): () => void {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => Object.defineProperty(process, 'platform', orig)
}

function fakeContainer(capture: (opts: Record<string, unknown>) => void) {
  return vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
    capture(opts)
    return {
      attach: vi.fn().mockResolvedValue({}),
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      modem: { demuxStream: vi.fn() },
    }
  })
}

describe('SandboxRunner.run — Windows containers option building', () => {
  it('builds Hyper-V isolated options with the cmd wrapper when the daemon reports Windows', async () => {
    const restore = stubPlatform('win32')
    try {
      const rc = defaultRc()
      let capturedOpts: Record<string, unknown> | undefined
      const fakeDocker = {
        info: vi.fn().mockResolvedValue({ OSType: 'windows' }),
        getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
        createContainer: fakeContainer(opts => { capturedOpts = opts }),
      } as unknown as import('dockerode').default

      const runner = new SandboxRunner(fakeDocker, rc)
      const script = makeScript('winpkg', '1.0.0')
      const result = await runner.run(script, '')

      expect(result.exitCode).toBe(0)
      expect(capturedOpts?.['Image']).toBe('sandboxpm-sandbox-win:latest')
      expect(capturedOpts?.['Cmd']).toEqual(['cmd', '/S', '/C', script.command])
      expect(capturedOpts?.['Entrypoint']).toEqual([])
      const hostConfig = capturedOpts?.['HostConfig'] as Record<string, unknown>
      expect(hostConfig['Isolation']).toBe('hyperv')
      expect(hostConfig['Memory']).toBe(512 * 1024 * 1024)
      // Windows containers reject these — confirm the Linux-only flags are absent.
      expect(hostConfig['PidsLimit']).toBeUndefined()
      expect(hostConfig['CapDrop']).toBeUndefined()
      expect(hostConfig['ReadonlyRootfs']).toBeUndefined()
      expect((capturedOpts?.['Env'] as string[])[0]).toContain('NODE_PATH=C:/npm/node_modules')
    } finally { restore() }
  })

  it('sets NetworkMode:none on Windows when sandbox.networkMode is "none"', async () => {
    const restore = stubPlatform('win32')
    try {
      const rc = { ...defaultRc(), sandbox: { ...defaultRc().sandbox, networkMode: 'none' as const } }
      let capturedOpts: Record<string, unknown> | undefined
      const fakeDocker = {
        info: vi.fn().mockResolvedValue({ OSType: 'windows' }),
        getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
        createContainer: fakeContainer(opts => { capturedOpts = opts }),
      } as unknown as import('dockerode').default

      const runner = new SandboxRunner(fakeDocker, rc)
      await runner.run(makeScript('winpkg', '1.0.0'), '')

      const hostConfig = capturedOpts?.['HostConfig'] as Record<string, unknown>
      expect(hostConfig['NetworkMode']).toBe('none')
    } finally { restore() }
  })

  it('does not set NetworkMode on Windows for the default (non-"none") network mode', async () => {
    const restore = stubPlatform('win32')
    try {
      const rc = defaultRc() // default networkMode: 'isolated'
      let capturedOpts: Record<string, unknown> | undefined
      const fakeDocker = {
        info: vi.fn().mockResolvedValue({ OSType: 'windows' }),
        getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
        createContainer: fakeContainer(opts => { capturedOpts = opts }),
      } as unknown as import('dockerode').default

      const runner = new SandboxRunner(fakeDocker, rc)
      await runner.run(makeScript('winpkg', '1.0.0'), '')

      const hostConfig = capturedOpts?.['HostConfig'] as Record<string, unknown>
      expect(hostConfig['NetworkMode']).toBeUndefined()
    } finally { restore() }
  })

  it('builds the Windows image when it is not already present', async () => {
    const restore = stubPlatform('win32')
    try {
      const rc = defaultRc()
      const fakeDocker = {
        info: vi.fn().mockResolvedValue({ OSType: 'windows' }),
        getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockRejectedValue(new Error('no such image')) }),
        createContainer: fakeContainer(() => {}),
      } as unknown as import('dockerode').default

      const runner = new SandboxRunner(fakeDocker, rc)
      const result = await runner.run(makeScript('winpkg', '1.0.0'), '')

      expect(result.exitCode).toBe(0)
    } finally { restore() }
  })
})

describe('SandboxRunner.run — env passthrough', () => {
  it('passes through an explicitly allow-listed host env var', async () => {
    const rc = defaultRc()
    rc.envPassthrough = ['SANDBOXPM_TEST_VAR']
    process.env['SANDBOXPM_TEST_VAR'] = 'hello'

    try {
      let capturedOpts: Record<string, unknown> | undefined
      const fakeDocker = {
        listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
        getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
        createContainer: fakeContainer(opts => { capturedOpts = opts }),
      } as unknown as import('dockerode').default

      const runner = new SandboxRunner(fakeDocker, rc)
      await runner.run(makeScript('pkg', '1.0.0'), '')

      expect(capturedOpts?.['Env']).toEqual([
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'NODE_PATH=/sandbox/deps',
        'SANDBOXPM_TEST_VAR=hello',
      ])
    } finally {
      delete process.env['SANDBOXPM_TEST_VAR']
    }
  })

  it('does not pass through an allow-listed var that is unset on the host', async () => {
    const rc = defaultRc()
    rc.envPassthrough = ['SANDBOXPM_UNSET_VAR']
    delete process.env['SANDBOXPM_UNSET_VAR']

    let capturedOpts: Record<string, unknown> | undefined
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: fakeContainer(opts => { capturedOpts = opts }),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    await runner.run(makeScript('pkg', '1.0.0'), '')

    expect(capturedOpts?.['Env']).toEqual(['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_PATH=/sandbox/deps'])
  })
})

describe('SandboxRunner.run — container start failure', () => {
  it('returns a blocked sandboxReport when createContainer throws', async () => {
    const rc = defaultRc()
    const fakeDocker = {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      createContainer: vi.fn().mockRejectedValue(new Error('cannot connect to the Docker daemon')),
    } as unknown as import('dockerode').default

    const runner = new SandboxRunner(fakeDocker, rc)
    const result = await runner.run(makeScript('pkg', '1.0.0'), '')

    expect(result.exitCode).toBe(1)
    expect(result.sandboxReport?.status).toBe('blocked')
    expect(result.sandboxReport?.unexpectedActivity).toEqual(['cannot connect to the Docker daemon'])
  })
})

describe('SandboxRunner.run — nested dependency scopes on disk (Linux path)', () => {
  it('creates a writable tmpfs scope + read-only bind for a real sibling dependency', async () => {
    const { mkdtemp, mkdir, rm } = await import('fs/promises')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const root = await mkdtemp(join(tmpdir(), 'sandboxpm-deps-test-'))
    const depsDir = join(root, 'deps')
    const packageDir = join(depsDir, 'pkgA')
    await mkdir(join(depsDir, 'dep1'), { recursive: true })
    await mkdir(packageDir, { recursive: true })

    try {
      const rc = defaultRc()
      let capturedOpts: Record<string, unknown> | undefined
      const fakeDocker = {
        listNetworks: vi.fn().mockResolvedValue([{ Name: 'sandboxpm-net' }]),
        getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
        createContainer: fakeContainer(opts => { capturedOpts = opts }),
      } as unknown as import('dockerode').default

      const runner = new SandboxRunner(fakeDocker, rc)
      await runner.run(makeScript('pkgA', '1.0.0'), packageDir)

      const hostConfig = capturedOpts?.['HostConfig'] as Record<string, unknown>
      const tmpfs = hostConfig['Tmpfs'] as Record<string, string>
      expect(Object.keys(tmpfs).some(k => k.startsWith('/sandbox/scopes/'))).toBe(true)
      expect((hostConfig['Binds'] as string[]).some(b => b.includes('dep1') && b.endsWith(':ro'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

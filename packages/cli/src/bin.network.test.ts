import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import type { ChildProcess } from 'node:child_process'

// ─── mocks that must stay in effect for the whole file ────────────────────────
//
// dockerode + @sandboxpm/scripts' SandboxRunner are faked everywhere so no real
// container logic ever runs. node:child_process/spawn and node:readline/promises
// are faked so pack/publish/exec/run never shell out or block on stdin; each test
// configures the specific return value it needs via the hoisted mock fns below.

const scriptsRunMock = vi.hoisted(() => vi.fn())
vi.mock('dockerode', () => ({ default: class FakeDockerode {} }))
vi.mock('@sandboxpm/scripts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@sandboxpm/scripts')>()
  return {
    ...orig,
    SandboxRunner: vi.fn().mockImplementation(function FakeSandboxRunner() {
      return { run: scriptsRunMock }
    }),
  }
})

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const questionMock = vi.hoisted(() => vi.fn())
const rlCloseMock = vi.hoisted(() => vi.fn())
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: questionMock, close: rlCloseMock })),
}))

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-cli-net-test-'))
  scriptsRunMock.mockReset().mockResolvedValue({ exitCode: 0 })
  spawnMock.mockReset()
  questionMock.mockReset()
  rlCloseMock.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writePackageJson(dir: string, content: object) {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

// ─── fake child_process helper (for pack/publish/run-native) ──────────────────

function makeFakeChild(exitCode: number, stdoutText = ''): ChildProcess {
  const proc = {
    stdout: {
      on(ev: string, cb: (d: Buffer) => void) {
        if (ev === 'data' && stdoutText) queueMicrotask(() => cb(Buffer.from(stdoutText)))
      },
    },
    on(ev: string, cb: (...args: unknown[]) => void) {
      if (ev === 'close') queueMicrotask(() => cb(exitCode))
      return proc
    },
  }
  return proc as unknown as ChildProcess
}

// ─── packument helper (mirrors resolver/src/index.test.ts's makePackument) ────

function makePackument(name: string, versions: Record<string, { deps?: Record<string, string> }>) {
  const versionsObj: Record<string, object> = {}
  for (const [v, opts] of Object.entries(versions)) {
    versionsObj[v] = {
      name,
      version: v,
      dist: {
        tarball: `https://registry.npmjs.org/${name}/-/${name}-${v}.tgz`,
        integrity: `sha512-${Buffer.from(`${name}@${v}`).toString('base64')}`,
      },
      dependencies: opts.deps ?? {},
    }
  }
  const latestVersion = Object.keys(versions).sort().at(-1) ?? '1.0.0'
  return { name, versions: versionsObj, 'dist-tags': { latest: latestVersion } }
}

function mockPackumentFetch(registry: Record<string, ReturnType<typeof makePackument>>) {
  return vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url: unknown) => {
    const urlStr = String(url)
    const name = urlStr.replace('https://registry.npmjs.org/', '')
    const packument = registry[name]
    if (!packument) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
    }
    return { ok: true, status: 200, json: async () => packument } as Response
  })
}

// ─── hand-rolled ustar+gzip tarball builder ────────────────────────────────────
//
// packages/cli does not depend on the `tar` package (only @sandboxpm/fetcher
// does), and pnpm's strict node_modules means it isn't resolvable from here.
// Rather than add a new dependency, build a minimal valid POSIX ustar archive
// by hand with zlib (stdlib) — verified against the real `tar` package's
// extractor before writing this file.

function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 'utf8')
  buf.write('0000644\0', 100, 'utf8')
  buf.write('0000000\0', 108, 'utf8')
  buf.write('0000000\0', 116, 'utf8')
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
  buf.write('00000000000\0', 136, 'utf8')
  buf.write('        ', 148, 'utf8') // checksum placeholder while summing
  buf.write('0', 156, 'utf8') // typeflag: regular file
  buf.write('ustar\0', 257, 'utf8')
  buf.write('00', 263, 'utf8')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i] ?? 0
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return buf
}

async function makeTarball(files: Record<string, string>): Promise<{ tgzPath: string; integrity: string }> {
  const parts: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const contentBuf = Buffer.from(content, 'utf8')
    parts.push(tarHeader(`package/${name}`, contentBuf.length), contentBuf)
    const pad = (512 - (contentBuf.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024)) // two zero blocks = end of archive
  const gz = zlib.gzipSync(Buffer.concat(parts))
  const tgzPath = path.join(tmpDir, `pkg-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`)
  await fs.writeFile(tgzPath, gz)
  const integrity = `sha512-${crypto.createHash('sha512').update(gz).digest('base64')}`
  return { tgzPath, integrity }
}

// Mocks resolver.fetchPackument (GET /{name}) + Fetcher.fetchPackumentVersion
// (GET /{name}/{version}) + the tarball download itself, all via global.fetch.
function mockExecFetch(opts: { name: string; version: string; tgzPath: string; integrity: string }) {
  return vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url: unknown) => {
    const s = String(url)
    if (s === `https://registry.npmjs.org/${opts.name}/${opts.version}`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: opts.name,
          version: opts.version,
          dist: {
            tarball: `https://registry.npmjs.org/${opts.name}/-/${opts.name}-${opts.version}.tgz`,
            integrity: opts.integrity,
          },
          scripts: {},
          dependencies: {},
        }),
      } as Response
    }
    if (s === `https://registry.npmjs.org/${opts.name}`) {
      return {
        ok: true,
        status: 200,
        json: async () => makePackument(opts.name, { [opts.version]: {} }),
      } as Response
    }
    if (s.endsWith('.tgz')) {
      const buf = await fs.readFile(opts.tgzPath)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(buf))
          controller.close()
        },
      })
      return { ok: true, status: 200, body: stream } as unknown as Response
    }
    throw new Error(`Unexpected fetch URL in test: ${s}`)
  })
}

// ─── info ───────────────────────────────────────────────────────────────────

describe('info', () => {
  it('prints metadata for an explicit version', async () => {
    mockPackumentFetch({ 'my-pkg': makePackument('my-pkg', { '1.2.3': {}, '1.0.0': {} }) })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { info } = await import('./bin.js')

    await info('my-pkg@1.2.3', {})

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('my-pkg@1.2.3')
  })

  it('resolves implicit "latest" when no version is specified', async () => {
    mockPackumentFetch({ 'my-pkg': makePackument('my-pkg', { '1.0.0': {}, '2.0.0': {} }) })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { info } = await import('./bin.js')

    await info('my-pkg', {})

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('my-pkg@2.0.0')
  })

  it('exits with error when the package is not found', async () => {
    mockPackumentFetch({})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { info } = await import('./bin.js')

    await info('does-not-exist', {}).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('prints JSON when flags.json is true', async () => {
    mockPackumentFetch({ 'my-pkg': makePackument('my-pkg', { '1.2.3': {} }) })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { info } = await import('./bin.js')

    await info('my-pkg@1.2.3', { json: true })

    expect(logSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(parsed.name).toBe('my-pkg')
    expect(parsed.version).toBe('1.2.3')
  })
})

// ─── search ───────────────────────────────────────────────────────────────────

interface FakeSearchObjects {
  objects: Array<{ package: { name: string; version: string; description?: string; author?: { name?: string } } }>
  total: number
}

function mockSearchFetch(data: FakeSearchObjects) {
  return vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async () => {
    return { ok: true, status: 200, json: async () => data } as Response
  })
}

describe('search', () => {
  it('prints text output for search results', async () => {
    mockSearchFetch({
      objects: [{ package: { name: 'foo-pkg', version: '1.0.0', description: 'a test package', author: { name: 'bob' } } }],
      total: 1,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { search } = await import('./bin.js')

    await search('foo', {})

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('foo-pkg')
    expect(output).toContain('a test package')
    expect(output).toContain('bob')
  })

  it('prints JSON when flags.json is true', async () => {
    mockSearchFetch({
      objects: [{ package: { name: 'foo-pkg', version: '1.0.0' } }],
      total: 1,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { search } = await import('./bin.js')

    await search('foo', { json: true })

    expect(logSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(parsed[0].package.name).toBe('foo-pkg')
  })

  it('exits with error when the registry request fails', async () => {
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async () => {
      return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) } as Response
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { search } = await import('./bin.js')

    await search('foo', {}).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── execPackage ────────────────────────────────────────────────────────────

describe('execPackage', () => {
  it('aborts without downloading when the user declines', async () => {
    questionMock.mockResolvedValue('n')
    mockPackumentFetch({ 'my-cli-tool': makePackument('my-cli-tool', { '1.0.0': {} }) })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { execPackage } = await import('./bin.js')

    // Only the packument endpoint is mocked — if the decline branch failed to
    // return early, the subsequent tarball download would hit the un-mocked
    // fetch fallback and reject, so a clean resolve is itself proof no
    // download was attempted.
    await expect(execPackage('my-cli-tool', [], {})).resolves.toBeUndefined()

    expect(scriptsRunMock).not.toHaveBeenCalled()
  })

  it('exits with error when the requested version does not exist', async () => {
    questionMock.mockResolvedValue('y')
    mockPackumentFetch({ 'my-cli-tool': makePackument('my-cli-tool', { '1.0.0': {} }) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { execPackage } = await import('./bin.js')

    await execPackage('my-cli-tool@9.9.9', [], {}).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('downloads and runs the package when bin is a string', async () => {
    questionMock.mockResolvedValue('y')
    const { tgzPath, integrity } = await makeTarball({
      'package.json': JSON.stringify({ name: 'my-cli-tool', version: '1.0.0', bin: 'cli.js' }),
      'cli.js': 'console.log("hi")',
    })
    mockExecFetch({ name: 'my-cli-tool', version: '1.0.0', tgzPath, integrity })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { execPackage } = await import('./bin.js')

    await execPackage('my-cli-tool@1.0.0', [], {})

    expect(scriptsRunMock).toHaveBeenCalledTimes(1)
    const taggedScript = scriptsRunMock.mock.calls[0]?.[0]
    expect(taggedScript.command).toMatch(/^node .*cli\.js$/)
  })

  it('downloads and runs the package when bin is an object, falling back to the first entry', async () => {
    questionMock.mockResolvedValue('y')
    const { tgzPath, integrity } = await makeTarball({
      'package.json': JSON.stringify({
        name: 'toolpkg',
        version: '1.0.0',
        bin: { 'unrelated-bin-name': 'tool.js' },
      }),
      'tool.js': 'console.log("hi")',
    })
    mockExecFetch({ name: 'toolpkg', version: '1.0.0', tgzPath, integrity })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { execPackage } = await import('./bin.js')

    await execPackage('toolpkg@1.0.0', [], {})

    expect(scriptsRunMock).toHaveBeenCalledTimes(1)
    const taggedScript = scriptsRunMock.mock.calls[0]?.[0]
    expect(taggedScript.command).toMatch(/^node .*tool\.js$/)
  })

  it('exits with error when the bin path escapes the temp dir', async () => {
    questionMock.mockResolvedValue('y')
    const { tgzPath, integrity } = await makeTarball({
      'package.json': JSON.stringify({ name: 'evil-pkg', version: '1.0.0', bin: '../../evil' }),
    })
    mockExecFetch({ name: 'evil-pkg', version: '1.0.0', tgzPath, integrity })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { execPackage } = await import('./bin.js')

    await execPackage('evil-pkg@1.0.0', [], {}).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(errOutput).toContain('Binary path escape detected')
    expect(scriptsRunMock).not.toHaveBeenCalled()
  })

  it('exits with error when no bin field is present', async () => {
    questionMock.mockResolvedValue('y')
    const { tgzPath, integrity } = await makeTarball({
      'package.json': JSON.stringify({ name: 'no-bin-pkg', version: '1.0.0' }),
    })
    mockExecFetch({ name: 'no-bin-pkg', version: '1.0.0', tgzPath, integrity })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { execPackage } = await import('./bin.js')

    await execPackage('no-bin-pkg@1.0.0', [], {}).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(errOutput).toContain('No binary entry point found')
  })
})

// ─── runScript — sandbox + native success paths ────────────────────────────────

describe('runScript — success paths', () => {
  it('runs in the Docker sandbox and exits with the runner exit code', async () => {
    await writePackageJson(tmpDir, { name: 'my-app', version: '1.0.0', scripts: { build: 'tsc' } })
    scriptsRunMock.mockResolvedValue({ exitCode: 7 })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { runScript } = await import('./bin.js')

    await runScript('build', [], { cwd: tmpDir, sandbox: true })

    expect(scriptsRunMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(7)
  })

  it('runs natively (no sandbox) and exits with the spawned process exit code', async () => {
    await writePackageJson(tmpDir, { name: 'my-app', version: '1.0.0', scripts: { build: 'echo hi' } })
    spawnMock.mockReturnValue(makeFakeChild(5))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { runScript } = await import('./bin.js')

    await runScript('build', [], { cwd: tmpDir })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(5)
  })
})

// ─── pack ─────────────────────────────────────────────────────────────────────

describe('pack', () => {
  it('creates a tarball and prints its name', async () => {
    await writePackageJson(tmpDir, { name: 'my-pkg', version: '1.0.0' })
    spawnMock.mockReturnValue(makeFakeChild(0, 'my-pkg-1.0.0.tgz\n'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { pack } = await import('./bin.js')

    await pack({ cwd: tmpDir })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('my-pkg-1.0.0.tgz')
  })

  it('exits with error and does not spawn when the package is private', async () => {
    await writePackageJson(tmpDir, { name: 'my-pkg', version: '1.0.0', private: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { pack } = await import('./bin.js')

    await pack({ cwd: tmpDir }).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('warns but still proceeds when a sensitive file is present', async () => {
    await writePackageJson(tmpDir, { name: 'my-pkg', version: '1.0.0' })
    await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET=1')
    spawnMock.mockReturnValue(makeFakeChild(0, 'my-pkg-1.0.0.tgz\n'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { pack } = await import('./bin.js')

    await pack({ cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('.env')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('exits with error when npm pack exits non-zero', async () => {
    await writePackageJson(tmpDir, { name: 'my-pkg', version: '1.0.0' })
    spawnMock.mockReturnValue(makeFakeChild(1))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { pack } = await import('./bin.js')

    await pack({ cwd: tmpDir }).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(errOutput).toContain('Pack failed')
  })
})

// ─── publish ──────────────────────────────────────────────────────────────────

describe('publish', () => {
  it('exits with error when the package is private', async () => {
    await writePackageJson(tmpDir, { name: 'my-pkg', private: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { publish } = await import('./bin.js')

    await publish({ cwd: tmpDir })

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('exits with error for unscoped packages without --access public', async () => {
    await writePackageJson(tmpDir, { name: 'my-pkg' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { publish } = await import('./bin.js')

    await publish({ cwd: tmpDir })

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('succeeds for a scoped package without --access', async () => {
    await writePackageJson(tmpDir, { name: '@scope/my-pkg' })
    spawnMock.mockReturnValue(makeFakeChild(0))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { publish } = await import('./bin.js')

    await publish({ cwd: tmpDir })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('warns when a registry token is found in .sandboxpmrc but still proceeds', async () => {
    await writePackageJson(tmpDir, { name: '@scope/my-pkg' })
    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    const rc = defaultRc()
    rc.registries[0]!.token = 'super-secret-token'
    await saveRc(tmpDir, rc)
    spawnMock.mockReturnValue(makeFakeChild(0))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { publish } = await import('./bin.js')

    await publish({ cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('registry.token found')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('aborts without publishing when a sensitive file is present and the user declines', async () => {
    await writePackageJson(tmpDir, { name: '@scope/my-pkg' })
    await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET=1')
    questionMock.mockResolvedValue('n')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { publish } = await import('./bin.js')

    await publish({ cwd: tmpDir })

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('proceeds to publish when a sensitive file is present and the user confirms', async () => {
    await writePackageJson(tmpDir, { name: '@scope/my-pkg' })
    await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET=1')
    questionMock.mockResolvedValue('y')
    spawnMock.mockReturnValue(makeFakeChild(0))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { publish } = await import('./bin.js')

    await publish({ cwd: tmpDir })

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})

// ─── linkPackage / unlinkPackage (nice-to-have, no network/spawn involved) ─────

describe('linkPackage / unlinkPackage', () => {
  it('registers the current package globally and unregisters it', async () => {
    await writePackageJson(tmpDir, { name: 'my-linkable-lib-net-test' })
    const { linkPackage, unlinkPackage } = await import('./bin.js')
    const { loadGlobalConfig } = await import('@sandboxpm/config')

    await linkPackage(undefined, { cwd: tmpDir })
    const gc = await loadGlobalConfig()
    const linkPath = path.join(path.dirname(gc.storeDir), 'links', 'my-linkable-lib-net-test')
    const real = await fs.realpath(linkPath)
    expect(path.resolve(real)).toBe(path.resolve(await fs.realpath(tmpDir)))

    await unlinkPackage(undefined, { cwd: tmpDir })
    await expect(fs.access(linkPath)).rejects.toThrow()
  })

  it('exits with error when linking a package that is not found', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { linkPackage } = await import('./bin.js')

    await linkPackage('does-not-exist-anywhere', { cwd: tmpDir }).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('links a local path into node_modules and unlinks it', async () => {
    const otherPkgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-otherpkg-net-'))
    try {
      await writePackageJson(otherPkgDir, { name: 'other-pkg-net-test' })
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { linkPackage, unlinkPackage } = await import('./bin.js')

      await linkPackage(otherPkgDir, { cwd: tmpDir })
      const destPath = path.join(tmpDir, 'node_modules', 'other-pkg-net-test')
      const real = await fs.realpath(destPath)
      expect(path.resolve(real)).toBe(path.resolve(await fs.realpath(otherPkgDir)))

      await unlinkPackage('other-pkg-net-test', { cwd: tmpDir })
      await expect(fs.access(destPath)).rejects.toThrow()
    } finally {
      await fs.rm(otherPkgDir, { recursive: true, force: true })
    }
  })
})

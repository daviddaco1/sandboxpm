import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { ChildProcess } from 'node:child_process'

// This file exists purely to drive the thin `.action(...)` dispatcher lines for
// commands whose business logic is already covered by direct-call tests elsewhere
// (bin.test.ts, bin.network.test.ts) but whose commander wiring (the `cwd ? {cwd} : {}`
// / `opts.x ? {...} : {}` ternaries near the bottom of bin.ts) was never actually
// exercised through `program.parseAsync` — those ternary branches show up as
// uncovered in `pnpm test:coverage` even though the underlying functions are tested.
// See bin.cli-wiring.test.ts for the non-exported (cacheStats/cacheWarm/auditReports/
// config get|set) handlers this file's sibling covers instead.

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
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: questionMock, close: vi.fn() })),
}))

// login/logout write to `~/.sandboxpm/auth.json` via node:os's homedir() — redirect
// it into our tmpDir so the test never touches the real developer machine's home.
const fakeHomeState = { current: '' }
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, homedir: () => fakeHomeState.current }
})

// link/unlink resolve their global links dir from loadGlobalConfig()'s storeDir —
// redirect that into our tmpDir too, so we never touch the real ~/.sandboxpm/links.
const globalConfigState = { current: { storeDir: '', cacheDir: '', reportsDir: '' } }
vi.mock('@sandboxpm/config', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, loadGlobalConfig: async () => ({ ...globalConfigState.current }) }
})

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

let program: typeof import('commander')['program']

beforeAll(async () => {
  await import('./bin.js')
  ;({ program } = await import('commander'))
})

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-cli-wiring-extra-'))
  fakeHomeState.current = path.join(tmpDir, 'fakehome')
  globalConfigState.current = {
    storeDir: path.join(tmpDir, 'store'),
    cacheDir: path.join(tmpDir, 'cache'),
    reportsDir: path.join(tmpDir, 'reports'),
  }
  scriptsRunMock.mockReset().mockResolvedValue({ exitCode: 0 })
  spawnMock.mockReset().mockReturnValue(makeFakeChild(0))
  questionMock.mockReset().mockResolvedValue('y')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function run(argv: string[]) {
  return program.parseAsync(argv, { from: 'user' })
}

// commander's global --cwd option value persists on the shared `program` instance
// across parseAsync calls once set — explicitly clear it before a test that means
// to exercise the "no --cwd given" (`cwd ? {cwd} : {}` falsy) dispatcher branch,
// otherwise it silently reuses whatever a previous test last passed.
function resetCwdOption() {
  program.setOptionValue('cwd', undefined)
}

async function writePackageJson(dir: string, content: object) {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

// ─── run / test / start / stop ──────────────────────────────────────────────────

describe('run (CLI dispatch)', () => {
  it('dispatches natively without --sandbox', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0', scripts: { build: 'echo hi' } })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['run', 'build', '--cwd', tmpDir])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('dispatches through the Docker sandbox with --sandbox', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0', scripts: { build: 'echo hi' } })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['run', 'build', '--sandbox', '--cwd', tmpDir])
    expect(scriptsRunMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe('test / start / stop aliases (CLI dispatch)', () => {
  it('dispatches the "test" alias natively', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0', scripts: { test: 'echo hi' } })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['test', '--cwd', tmpDir])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('dispatches the "start" alias with --sandbox', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0', scripts: { start: 'echo hi' } })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['start', '--sandbox', '--cwd', tmpDir])
    expect(scriptsRunMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('dispatches the "stop" alias natively', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0', scripts: { stop: 'echo hi' } })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['stop', '--cwd', tmpDir])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

// ─── exec ────────────────────────────────────────────────────────────────────────

describe('exec (CLI dispatch)', () => {
  it('dispatches and exits(1) when the package cannot be resolved', async () => {
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async () => {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['exec', 'does-not-exist-anywhere', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── update ──────────────────────────────────────────────────────────────────────

describe('update (CLI dispatch)', () => {
  it('dispatches without --latest (deletes lockfile, reinstalls within current ranges)', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0', dependencies: {} })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['update', '--cwd', tmpDir])
    await fs.access(path.join(tmpDir, 'sandboxpm.lock'))
  })

  it('dispatches with --latest', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0', dependencies: {} })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['update', '--latest', '--cwd', tmpDir])
  })
})

// ─── version (the falsy --cwd branch is safe here: root package.json is private,
// but bumpVersion doesn't check `private` — pick an invalid bump so it errors out
// on a pure read before anything could be mutated) ────────────────────────────────

describe('version (CLI dispatch)', () => {
  it('dispatches with an explicit --cwd', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['version', 'patch', '--no-git-tag', '--cwd', tmpDir])
    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkg.version).toBe('1.0.1')
  })

  it('dispatches without --cwd and surfaces an invalid-bump error (read-only, no mutation)', async () => {
    resetCwdOption()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['version', 'not-a-real-bump']).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(errOutput).toContain('Invalid version bump')
  })
})

// link/unlink's nested `.command('[path]')`/`.command('[name]')` subcommand syntax
// doesn't dispatch cleanly through parseAsync with a preceding global --cwd option
// (commander shows the parent command's help instead) — linkPackage/unlinkPackage
// already have solid direct-call coverage in bin.network.test.ts and
// bin.cli-wiring.test.ts, so CLI-dispatch coverage for these two is skipped here.

// ─── pack / publish (falsy --cwd branch is safe: repo root package.json is
// `private: true`, so both hit the private-package exit path before any spawn) ──────

describe('pack / publish (CLI dispatch)', () => {
  it('pack dispatches with an explicit --cwd', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['pack', '--cwd', tmpDir])
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('pack dispatches without --cwd against the private repo root (no spawn)', async () => {
    resetCwdOption()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['pack']).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('private')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('publish dispatches with --access and --registry', async () => {
    await writePackageJson(tmpDir, { name: 'app', version: '1.0.0' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['publish', '--access', 'public', '--registry', 'https://example.registry.test', '--cwd', tmpDir])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args).toContain('--access')
    expect(args).toContain('--registry')
  })

  it('publish dispatches without --cwd against the private repo root (no spawn)', async () => {
    resetCwdOption()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['publish']).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('private')
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

// ─── login / logout (--registry flag branch) ────────────────────────────────────

describe('login / logout with --registry (CLI dispatch)', () => {
  it('login dispatches with an explicit --registry', async () => {
    questionMock.mockResolvedValue('a-token')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['login', '--registry', 'https://example.registry.test'])
  })

  it('logout dispatches with an explicit --registry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(['logout', '--registry', 'https://example.registry.test'])
  })
})

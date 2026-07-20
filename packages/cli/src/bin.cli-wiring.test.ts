import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as nodeOs from 'node:os'

// NOTE on why this file drives commander instead of importing functions directly
// (unlike bin.test.ts, whose top comment says "we test exported functions directly"):
// the functions covered here (cacheStats, cacheWarm, auditReports, and the inline
// `config get`/`config set` action bodies) are either non-exported top-level
// functions or have no standalone function at all — the ONLY way to execute them
// is to actually dispatch through commander's `.action(...)` callbacks. This file
// also opportunistically drives a handful of already-exported/-tested commands
// through their CLI dispatcher lines for coverage ROI.

// ─── module-level mock state ───────────────────────────────────────────────────
// bin.ts's top-level `import { loadGlobalConfig, saveGlobalConfig } from '@sandboxpm/config'`
// and `import * as os from 'node:os'` are ES module bindings resolved once, the first
// time bin.js is dynamically imported (in beforeAll below). vi.doMock must run before
// that import; the mocked implementations then read these mutable closures live on
// every call, so each test can just reassign the state instead of re-mocking.

const globalConfigState = {
  current: { storeDir: '', cacheDir: '', reportsDir: '' },
}
const saveGlobalConfigCalls: unknown[] = []
let fakeHome = ''

vi.doMock('@sandboxpm/config', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadGlobalConfig: async () => ({ ...globalConfigState.current }),
    saveGlobalConfig: async (cfg: unknown) => {
      saveGlobalConfigCalls.push(cfg)
      globalConfigState.current = cfg as typeof globalConfigState.current
    },
  }
})

vi.doMock('node:os', async (importOriginal) => {
  const original = await importOriginal() as typeof import('node:os')
  return { ...original, homedir: () => fakeHome }
})

vi.doMock('node:readline/promises', () => ({
  createInterface: () => ({
    question: vi.fn().mockResolvedValue('fake-token'),
    close: vi.fn(),
  }),
}))

let program: typeof import('commander')['program']

beforeAll(async () => {
  await import('./bin.js') // side effect: registers all commands on the commander singleton
  ;({ program } = await import('commander'))
})

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(nodeOs.tmpdir(), 'sandboxpm-cli-wiring-test-'))
  globalConfigState.current = {
    storeDir: path.join(tmpDir, 'store'),
    cacheDir: path.join(tmpDir, 'cache'),
    reportsDir: path.join(tmpDir, 'reports'),
  }
  saveGlobalConfigCalls.length = 0
  fakeHome = path.join(tmpDir, 'fakehome')
})

afterEach(async () => {
  vi.restoreAllMocks() // only restores spies (process.exit/console.*) — doMock state above is untouched
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writePackageJson(dir: string, content: object) {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

async function run(argv: string[]) {
  return program.parseAsync(argv, { from: 'user' })
}

// ─── cache stats / cache warm ───────────────────────────────────────────────────

describe('cache stats (CLI dispatch)', () => {
  it('prints store size and file count for an empty/missing store', async () => {
    const logSpy = vi.spyOn(console, 'log')
    await run(['cache', 'stats'])
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('Store:')
    expect(output).toContain('Files:')
  })
})

describe('cache warm (CLI dispatch)', () => {
  it('resolves an empty dependency tree and writes a lockfile, then reuses it on a second run', async () => {
    await writePackageJson(tmpDir, { name: 'warm-app', version: '1.0.0', dependencies: {} })

    await run(['cache', 'warm', '--cwd', tmpDir])
    await fs.access(path.join(tmpDir, 'sandboxpm.lock')) // resolver.resolve() wrote it

    // Second run should hit the resolveFromLock branch instead of resolve()
    await run(['cache', 'warm', '--cwd', tmpDir])
  })

  it('exits with error when resolution fails (no package.json)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['cache', 'warm', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── audit ──────────────────────────────────────────────────────────────────────

describe('audit (CLI dispatch)', () => {
  it('prints "No audit reports found" when the reports dir does not exist', async () => {
    const logSpy = vi.spyOn(console, 'log')
    await run(['audit'])
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('No audit reports found')
  })

  it('prints "No audit reports found" when the reports dir exists but is empty', async () => {
    await fs.mkdir(globalConfigState.current.reportsDir, { recursive: true })
    const logSpy = vi.spyOn(console, 'log')
    await run(['audit'])
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('No audit reports found')
  })

  it('prints a summary per valid report and silently skips malformed ones', async () => {
    const reportsDir = globalConfigState.current.reportsDir
    await fs.mkdir(reportsDir, { recursive: true })

    await fs.writeFile(path.join(reportsDir, 'a-good.json'), JSON.stringify({
      packageId: 'left-pad@1.3.0',
      lifecycle: 'postinstall',
      decision: 'run',
      exitCode: 0,
      durationMs: 1234,
      sandboxReport: { status: 'clean', audited: true, unexpectedActivity: [] },
    }))
    await fs.writeFile(path.join(reportsDir, 'b-good.json'), JSON.stringify({
      packageId: 'bad-pkg@1.0.0',
      lifecycle: 'install',
      decision: 'blacklisted',
      exitCode: 1,
      sandboxReport: { status: 'blocked', unexpectedActivity: ['network:evil.example'] },
    }))
    await fs.writeFile(path.join(reportsDir, 'c-malformed.json'), '{ not valid json')

    const logSpy = vi.spyOn(console, 'log')
    await run(['audit'])
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')

    expect(output).toContain('3 script run') // count includes the malformed file, before the catch skips it
    expect(output).toContain('left-pad@1.3.0')
    expect(output).toContain('bad-pkg@1.0.0')
  })

  it('reports risk-*.json files separately without breaking the script-run count', async () => {
    const reportsDir = globalConfigState.current.reportsDir
    await fs.mkdir(reportsDir, { recursive: true })

    await fs.writeFile(path.join(reportsDir, 'a-good.json'), JSON.stringify({
      packageId: 'left-pad@1.3.0',
      lifecycle: 'postinstall',
      decision: 'run',
      exitCode: 0,
      sandboxReport: { status: 'clean', audited: true, unexpectedActivity: [] },
    }))
    await fs.writeFile(path.join(reportsDir, 'risk-lodahs-1700000000000.json'), JSON.stringify({
      name: 'lodahs',
      version: '1.0.0',
      reasons: ['typosquat:lodash(distance=1)', 'new-package(few published versions)'],
      severity: 'high',
      decision: 'trust',
    }))

    const logSpy = vi.spyOn(console, 'log')
    await run(['audit'])
    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')

    expect(output).toContain('1 script run') // risk report is excluded from the script-run count
    expect(output).toContain('1 package risk report')
    expect(output).toContain('lodahs@1.0.0')
    expect(output).toContain('typosquat:lodash')
  })
})

// ─── config get / config set ────────────────────────────────────────────────────

describe('config get / set (CLI dispatch)', () => {
  it('config get with no key prints the full JSON config', async () => {
    const logSpy = vi.spyOn(console, 'log')
    await run(['config', 'get'])
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(globalConfigState.current, null, 2))
  })

  it('config get storeDir prints just that value', async () => {
    const logSpy = vi.spyOn(console, 'log')
    await run(['config', 'get', 'storeDir'])
    expect(logSpy).toHaveBeenCalledWith(globalConfigState.current.storeDir)
  })

  it('config get badKey prints an error and exits 1', async () => {
    const errorSpy = vi.spyOn(console, 'error')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['config', 'get', 'badKey'])
    expect(errorSpy).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('config set storeDir persists the new value via saveGlobalConfig', async () => {
    await run(['config', 'set', 'storeDir', '/some/path'])
    expect(saveGlobalConfigCalls).toHaveLength(1)
    expect(saveGlobalConfigCalls[0]).toMatchObject({ storeDir: '/some/path' })
  })

  it('config set badKey prints an error and exits 1', async () => {
    const errorSpy = vi.spyOn(console, 'error')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['config', 'set', 'badKey', 'x'])
    expect(errorSpy).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── trivial one-line .action() dispatcher wrappers ─────────────────────────────
// Business logic for these is already covered directly in bin.test.ts; here we
// just need the dispatcher line inside the .action() callback to execute.

describe('trivial dispatcher wrappers (CLI dispatch)', () => {
  it('install exits(1) cleanly when there is no package.json', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['install', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('add exits(1) cleanly when there is no package.json', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['add', 'lodash', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('remove exits(1) cleanly when there is no package.json', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['remove', 'lodash', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('init creates package.json and .sandboxpmrc', async () => {
    await run(['init', '-y', '--cwd', tmpDir])
    await fs.access(path.join(tmpDir, 'package.json'))
    await fs.access(path.join(tmpDir, '.sandboxpmrc'))
  })

  it('whitelist add then whitelist remove round-trip', async () => {
    await run(['whitelist', 'add', 'trusted-pkg', '--cwd', tmpDir])
    const { loadRc } = await import('@sandboxpm/config')
    expect((await loadRc(tmpDir)).whitelist).toContain('trusted-pkg')

    await run(['whitelist', 'remove', 'trusted-pkg', '--cwd', tmpDir])
    expect((await loadRc(tmpDir)).whitelist).not.toContain('trusted-pkg')
  })

  it('trust add then trust remove round-trip', async () => {
    await run(['trust', 'add', 'some-lib', '--cwd', tmpDir])
    const { loadRc } = await import('@sandboxpm/config')
    expect((await loadRc(tmpDir)).trustedPackages).toContain('some-lib')

    await run(['trust', 'remove', 'some-lib', '--cwd', tmpDir])
    expect((await loadRc(tmpDir)).trustedPackages).not.toContain('some-lib')
  })

  it('block add then block remove round-trip', async () => {
    await run(['block', 'add', 'known-bad', '--cwd', tmpDir])
    const { loadRc } = await import('@sandboxpm/config')
    expect((await loadRc(tmpDir)).blockedPackages).toContain('known-bad')

    await run(['block', 'remove', 'known-bad', '--cwd', tmpDir])
    expect((await loadRc(tmpDir)).blockedPackages).not.toContain('known-bad')
  })

  it('ls exits(1) cleanly when there is no sandboxpm.lock', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['ls', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('why exits(1) cleanly when there is no sandboxpm.lock', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['why', 'some-package', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('outdated exits(1) cleanly when there is no sandboxpm.lock', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run(['outdated', '--cwd', tmpDir]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('version <bump> patches the version with --no-git-tag (no real git commands)', async () => {
    await writePackageJson(tmpDir, { name: 'bump-app', version: '1.0.0' })
    await run(['version', 'patch', '--no-git-tag', '--cwd', tmpDir])
    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkg.version).toBe('1.0.1')
  })

  it('login prompts for a token (mocked readline) and saves it under the mocked home dir', async () => {
    await run(['login', '--registry', 'https://example.registry.test'])
    const auth = JSON.parse(
      await fs.readFile(path.join(fakeHome, '.sandboxpm', 'auth.json'), 'utf8')
    ) as Record<string, string>
    expect(auth['https://example.registry.test']).toBe('fake-token')
  })

  it('logout dispatcher runs cleanly when not logged in', async () => {
    await run(['logout', '--registry', 'https://example.registry.test'])
  })
})

// ─── linkPackage / unlinkPackage (direct call — simpler than commander's ────────
// unusual `.command('[path]')` no-name-subcommand syntax; equally valid for
// coverage since both functions are already exported) ───────────────────────────

describe('linkPackage / unlinkPackage (direct call)', () => {
  it('registers the current package globally, then unregisters it', async () => {
    await writePackageJson(tmpDir, { name: 'my-linkable-pkg', version: '1.0.0' })
    const { linkPackage, unlinkPackage } = await import('./bin.js')

    await linkPackage(undefined, { cwd: tmpDir })
    const linksDir = path.join(path.dirname(globalConfigState.current.storeDir), 'links')
    await fs.access(path.join(linksDir, 'my-linkable-pkg'))

    await unlinkPackage(undefined, { cwd: tmpDir })
    await expect(fs.access(path.join(linksDir, 'my-linkable-pkg'))).rejects.toThrow()
  })
})

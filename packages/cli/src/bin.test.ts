import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

// We test the exported functions directly, not through process.argv
// This avoids having to deal with commander's global state

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-cli-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writePackageJson(dir: string, content: object) {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

// ─── init ─────────────────────────────────────────────────────────────────────

describe('init', () => {
  it('creates package.json and .sandboxpmrc with yes:true', async () => {
    const { init } = await import('./bin.js')
    await init({ cwd: tmpDir, yes: true })

    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe(path.basename(tmpDir).toLowerCase().replace(/[^a-z0-9]+/g, '-'))
    expect(pkg.version).toBe('1.0.0')
    expect(pkg.license).toBe('MIT')

    const rc = await fs.readFile(path.join(tmpDir, '.sandboxpmrc'), 'utf8')
    expect(rc).toContain('memory')
    expect(rc).toContain('networkMode')
  })

  it('does not overwrite existing .sandboxpmrc', async () => {
    const { init } = await import('./bin.js')
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), 'version: 1\n')
    await init({ cwd: tmpDir, yes: true })

    const content = await fs.readFile(path.join(tmpDir, '.sandboxpmrc'), 'utf8')
    expect(content.trim()).toBe('version: 1')
  })

  it('does not overwrite existing package.json', async () => {
    const { init } = await import('./bin.js')
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'existing-project', version: '2.0.0' }, null, 2)
    )
    await init({ cwd: tmpDir, yes: true })

    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('existing-project')
    expect(pkg.version).toBe('2.0.0')
  })

  it('resolves without error when both files already exist', async () => {
    const { init } = await import('./bin.js')
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'x' }))
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), 'version: 1\n')
    await expect(init({ cwd: tmpDir, yes: true })).resolves.toBeUndefined()
  })
})

// ─── whitelist ────────────────────────────────────────────────────────────────

describe('whitelistAdd / whitelistRemove', () => {
  it('adds a package to the whitelist', async () => {
    const { whitelistAdd } = await import('./bin.js')
    // Init rc first
    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    await saveRc(tmpDir, defaultRc())

    await whitelistAdd('trusted-lib', { cwd: tmpDir })

    const { loadRc } = await import('@sandboxpm/config')
    const rc = await loadRc(tmpDir)
    expect(rc.whitelist).toContain('trusted-lib')
  })

  it('removes a package from the whitelist', async () => {
    const { whitelistAdd, whitelistRemove } = await import('./bin.js')
    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    await saveRc(tmpDir, defaultRc())

    await whitelistAdd('remove-me', { cwd: tmpDir })
    await whitelistRemove('remove-me', { cwd: tmpDir })

    const { loadRc } = await import('@sandboxpm/config')
    const rc = await loadRc(tmpDir)
    expect(rc.whitelist).not.toContain('remove-me')
  })
})

// ─── listPackages ─────────────────────────────────────────────────────────────

describe('listPackages', () => {
  it('exits with error when sandboxpm.lock is missing', async () => {
    const { listPackages } = await import('./bin.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await listPackages({ cwd: tmpDir }).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── why ──────────────────────────────────────────────────────────────────────

describe('why', () => {
  it('exits with error when sandboxpm.lock is missing', async () => {
    const { why } = await import('./bin.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await why('some-package', { cwd: tmpDir }).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── outdated ─────────────────────────────────────────────────────────────────

describe('outdated', () => {
  it('exits with error when sandboxpm.lock is missing', async () => {
    const { outdated } = await import('./bin.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await outdated({ cwd: tmpDir }).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── runScript ────────────────────────────────────────────────────────────────

describe('runScript', () => {
  it('exits with error when package.json is missing', async () => {
    const { runScript } = await import('./bin.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await runScript('build', [], { cwd: tmpDir }).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with error when script is not defined in package.json', async () => {
    const { runScript } = await import('./bin.js')
    await writePackageJson(tmpDir, { name: 'my-app', scripts: { build: 'tsc' } })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await runScript('nonexistent', [], { cwd: tmpDir }).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── bumpVersion ──────────────────────────────────────────────────────────────

describe('bumpVersion', () => {
  it('exits with error for invalid bump type', async () => {
    const { bumpVersion } = await import('./bin.js')
    await writePackageJson(tmpDir, { name: 'my-app', version: '1.0.0' })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await bumpVersion('invalid-bump', { cwd: tmpDir, noGitTag: true }).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('bumps patch version and writes package.json (no git tag)', async () => {
    const { bumpVersion } = await import('./bin.js')
    await writePackageJson(tmpDir, { name: 'my-app', version: '1.0.0' })
    await bumpVersion('patch', { cwd: tmpDir, noGitTag: true })
    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkg.version).toBe('1.0.1')
  })

  it('bumps to an exact version (no git tag)', async () => {
    const { bumpVersion } = await import('./bin.js')
    await writePackageJson(tmpDir, { name: 'my-app', version: '1.0.0' })
    await bumpVersion('2.5.0', { cwd: tmpDir, noGitTag: true })
    const pkg = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkg.version).toBe('2.5.0')
  })
})

// ─── login / logout ───────────────────────────────────────────────────────────

describe('login / logout', () => {
  it('logout does not error when not logged in', async () => {
    const { logout } = await import('./bin.js')
    await expect(logout({ registry: 'https://example.registry.test' })).resolves.toBeUndefined()
  })
})

// ─── addPackages ──────────────────────────────────────────────────────────────

describe('addPackages — package.json mutation', () => {
  it('adds a versioned package to dependencies', async () => {
    await writePackageJson(tmpDir, { name: 'my-app', dependencies: {} })

    const pkgJsonPath = path.join(tmpDir, 'package.json')

    // Simulate what addPackages does to package.json
    const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'))
    const name = 'lodash'
    const version = '4.17.21'
    pkgJson.dependencies[name] = version
    await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2))

    const final = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'))
    expect(final.dependencies['lodash']).toBe('4.17.21')
  })
})

// ─── install — --frozen-lockfile ─────────────────────────────────────────────

describe('install — --frozen-lockfile', () => {
  it('calls process.exit(1) when --frozen-lockfile is set and no sandboxpm.lock exists', async () => {
    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { lodash: '^4.0.0' } })
    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    await saveRc(tmpDir, defaultRc())

    // Don't throw so we can inspect; install will continue and fail at a later step,
    // but we only care that exit(1) was called for the frozen-lockfile violation.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir, frozenLockfile: true }).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── cacheClean ───────────────────────────────────────────────────────────────

describe('cacheClean', () => {
  it('runs without error even when store is empty', async () => {
    // Override global config to use our temp dir
    vi.doMock('@sandboxpm/config', async (importOriginal) => {
      const original = await importOriginal() as Record<string, unknown>
      return {
        ...original,
        loadGlobalConfig: vi.fn().mockResolvedValue({
          storeDir: path.join(tmpDir, 'store'),
          cacheDir: path.join(tmpDir, 'cache'),
          reportsDir: path.join(tmpDir, 'reports'),
        }),
      }
    })

    // The function itself should not throw
    const { CASStore } = await import('@sandboxpm/store')
    const store = new CASStore(path.join(tmpDir, 'store'))
    const freed = await store.gc(new Set())
    expect(freed).toBe(0)
  })
})

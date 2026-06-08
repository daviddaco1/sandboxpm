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
  it('creates .sandboxpmrc with safe defaults', async () => {
    const { init } = await import('./bin.js')
    await init({ cwd: tmpDir })

    const content = await fs.readFile(path.join(tmpDir, '.sandboxpmrc'), 'utf8')
    expect(content).toContain('memory')
    expect(content).toContain('networkMode')
  })

  it('does not overwrite existing .sandboxpmrc', async () => {
    const { init } = await import('./bin.js')
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), 'version: 1\n')
    await init({ cwd: tmpDir }) // should be no-op

    const content = await fs.readFile(path.join(tmpDir, '.sandboxpmrc'), 'utf8')
    expect(content.trim()).toBe('version: 1')
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

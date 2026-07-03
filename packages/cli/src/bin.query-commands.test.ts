import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import type { GlobalConfig } from '@sandboxpm/config'

// listPackages/why/outdated read a real `sandboxpm.lock` — the easiest way to get a
// realistic multi-package tree (direct + transitive deps) is to actually run
// install() against a fake registry and let the real Resolver write it, rather than
// hand-crafting the lockfile's internal shape. See bin.install.test.ts for the
// origin of this fetch-mocking approach (copied here rather than imported, to keep
// this file's fixtures independent).

vi.mock('dockerode', () => ({ default: class FakeDockerode {} }))

let currentGlobalConfig: GlobalConfig = { storeDir: '', cacheDir: '', reportsDir: '' }
vi.mock('@sandboxpm/config', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, loadGlobalConfig: async () => currentGlobalConfig }
})

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-cli-query-test-'))
  currentGlobalConfig = {
    storeDir: path.join(tmpDir, 'store'),
    cacheDir: path.join(tmpDir, 'cache'),
    reportsDir: path.join(tmpDir, 'reports'),
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writePackageJson(dir: string, content: object): Promise<void> {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

function silenceOutput() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
}

// ─── fake registry + tarball fixtures (see bin.install.test.ts for provenance) ────

interface VersionDef { deps?: Record<string, string> }

function makeUstarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 'utf8')
  buf.write('0000644\0', 100, 'utf8')
  buf.write('0000000\0', 108, 'utf8')
  buf.write('0000000\0', 116, 'utf8')
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
  buf.write('00000000000\0', 136, 'utf8')
  buf.write('        ', 148, 'utf8')
  buf.write('0', 156, 'utf8')
  buf.write('ustar\0', 257, 'utf8')
  buf.write('00', 263, 'utf8')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i] as number
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
  return buf
}

function makeTarGz(entries: Array<{ name: string; content: string }>): Buffer {
  const chunks: Buffer[] = []
  for (const { name, content } of entries) {
    const contentBuf = Buffer.from(content, 'utf8')
    chunks.push(makeUstarHeader(name, contentBuf.length))
    chunks.push(contentBuf)
    const pad = (512 - (contentBuf.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(chunks))
}

async function makeTarball(dir: string, uniqueId: string): Promise<{ tgzPath: string; integrity: string }> {
  const buf = makeTarGz([{ name: 'package/index.js', content: `module.exports = ${JSON.stringify(uniqueId)}\n` }])
  const tgzPath = path.join(dir, `tgz-${crypto.randomBytes(4).toString('hex')}.tgz`)
  await fs.writeFile(tgzPath, buf)
  const integrity = `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`
  return { tgzPath, integrity }
}

async function setupRegistry(
  dir: string,
  defs: Record<string, Record<string, VersionDef>>,
): Promise<{ packuments: Record<string, any>; tarballs: Map<string, string> }> {
  const tarballs = new Map<string, string>()
  const packuments: Record<string, any> = {}

  for (const [name, versions] of Object.entries(defs)) {
    const versionsObj: Record<string, any> = {}
    for (const [version, opts] of Object.entries(versions)) {
      const { tgzPath, integrity } = await makeTarball(dir, `${name}@${version}`)
      const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
      tarballs.set(tarballUrl, tgzPath)
      versionsObj[version] = {
        name,
        version,
        dist: { tarball: tarballUrl, integrity },
        dependencies: opts.deps ?? {},
        scripts: {},
      }
    }
    const latest = Object.keys(versions).sort().at(-1) as string
    packuments[name] = { name, versions: versionsObj, 'dist-tags': { latest } }
  }

  return { packuments, tarballs }
}

function registryFetchMock(packuments: Record<string, any>, tarballs: Map<string, string>) {
  return vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
    const u = String(url)

    if (u.endsWith('.tgz')) {
      const tgzPath = tarballs.get(u)
      if (!tgzPath) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
      const buf = await fs.readFile(tgzPath)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(buf))
          controller.close()
        },
      })
      return { ok: true, status: 200, body: stream }
    }

    const rest = u.replace('https://registry.npmjs.org/', '')
    const parts = rest.split('/')
    const name = parts[0]
    const packument = name ? packuments[name] : undefined
    if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }

    if (parts.length === 1) return { ok: true, status: 200, json: async () => packument }

    const version = parts[1]
    const pv = version ? packument.versions[version] : undefined
    if (!pv) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    return { ok: true, status: 200, json: async () => pv }
  })
}

/**
 * Installs a realistic tree: direct deps pkg-a (leaf) and pkg-b (-> pkg-c
 * transitively). `resolveFromLock` (what listPackages/why/outdated all use)
 * recomputes `directDeps` fresh from package.json every call rather than trusting
 * anything stored in the lockfile — so appending "ghost-pkg" to package.json
 * *after* install, without re-running it, naturally reproduces the "declared in
 * package.json but not in the lockfile" / "not installed" state without needing
 * a real registry entry for it.
 */
async function installFixtureTree(): Promise<void> {
  const { packuments, tarballs } = await setupRegistry(tmpDir, {
    'pkg-a': { '1.0.0': {} },
    'pkg-b': { '1.0.0': { deps: { 'pkg-c': '^1.0.0' } } },
    'pkg-c': { '1.0.0': {} },
  })
  registryFetchMock(packuments, tarballs)
  silenceOutput()
  await writePackageJson(tmpDir, {
    name: 'query-test-app',
    dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' },
  })
  const { install } = await import('./bin.js')
  await install({ cwd: tmpDir })
  vi.restoreAllMocks() // drop the fetch mock; query commands below don't need network

  const pkgJsonPath = path.join(tmpDir, 'package.json')
  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'))
  pkgJson.dependencies['ghost-pkg'] = '^1.0.0'
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2))
}

// ─── listPackages ─────────────────────────────────────────────────────────────

describe('listPackages — populated tree', () => {
  it('prints the tree with a not-installed direct dep and a blacklisted one', async () => {
    await installFixtureTree()
    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    const rc = defaultRc()
    rc.blacklist = ['pkg-a']
    await saveRc(tmpDir, rc)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listPackages } = await import('./bin.js')

    await listPackages({ cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('pkg-a')
    expect(output).toContain('[blacklisted]')
    expect(output).toContain('ghost-pkg')
    expect(output).toContain('not installed')
    expect(output).toContain('packages total')
  })

  it('prints transitive deps when --depth > 0', async () => {
    await installFixtureTree()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listPackages } = await import('./bin.js')

    await listPackages({ cwd: tmpDir, depth: 1 })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('pkg-c') // pkg-b's transitive dep, only shown at depth>0
  })

  it('prints JSON output', async () => {
    await installFixtureTree()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listPackages } = await import('./bin.js')

    await listPackages({ cwd: tmpDir, json: true })

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(parsed['pkg-a@1.0.0']).toBeDefined()
  })
})

// ─── why ──────────────────────────────────────────────────────────────────────

describe('why — populated tree', () => {
  it('reports a direct dependency', async () => {
    await installFixtureTree()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { why } = await import('./bin.js')

    await why('pkg-a', { cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('direct dependency')
  })

  it('reports a transitive dependency via its direct-dependent parent', async () => {
    await installFixtureTree()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { why } = await import('./bin.js')

    await why('pkg-c', { cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('pkg-c ← pkg-b')
    expect(output).toContain('(direct)')
  })

  it('reports when a package is not in the dependency tree at all', async () => {
    await installFixtureTree()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { why } = await import('./bin.js')

    await why('totally-unknown-pkg', { cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('not in the dependency tree')
  })
})

// ─── outdated ─────────────────────────────────────────────────────────────────

describe('outdated — populated tree', () => {
  it('lists packages with a newer latest version and skips up-to-date ones', async () => {
    await installFixtureTree()

    // pkg-a has a newer "latest" (2.0.0) than what's locked (1.0.0); pkg-b stays
    // put at 1.0.0 so it's reported as up to date and excluded from the results.
    const { packuments } = await setupRegistry(tmpDir, {
      'pkg-a': { '1.0.0': {}, '2.0.0': {} },
      'pkg-b': { '1.0.0': { deps: { 'pkg-c': '^1.0.0' } } },
    })
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url)
      const rest = u.replace('https://registry.npmjs.org/', '')
      const packument = packuments[rest]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
      return { ok: true, status: 200, json: async () => packument }
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { outdated } = await import('./bin.js')

    await outdated({ cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('pkg-a')
    expect(output).not.toContain('ghost-pkg') // unreachable registry entry — silently skipped
  })

  it('prints JSON output', async () => {
    await installFixtureTree()
    const { packuments } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {}, '2.0.0': {} } })
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url)
      const rest = u.replace('https://registry.npmjs.org/', '')
      const packument = packuments[rest]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
      return { ok: true, status: 200, json: async () => packument }
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { outdated } = await import('./bin.js')

    await outdated({ cwd: tmpDir, json: true })

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('prints "all up to date" when nothing changed', async () => {
    await installFixtureTree()
    const { packuments } = await setupRegistry(tmpDir, {
      'pkg-a': { '1.0.0': {} },
      'pkg-b': { '1.0.0': { deps: { 'pkg-c': '^1.0.0' } } },
    })
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url)
      const rest = u.replace('https://registry.npmjs.org/', '')
      const packument = packuments[rest]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
      return { ok: true, status: 200, json: async () => packument }
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { outdated } = await import('./bin.js')

    await outdated({ cwd: tmpDir })

    const output = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(output).toContain('up to date')
  })
})

// ─── cacheClean ───────────────────────────────────────────────────────────────
//
// The pre-existing "cacheClean" describe block in bin.test.ts never actually calls
// the exported cacheClean() — it tests CASStore.gc() directly instead — so the
// `rc.cache.ttlDays > 0` branch (true by default per defaultRc()) was never hit.

describe('cacheClean', () => {
  it('runs the gc + ttl-based gc against an empty store without throwing', async () => {
    silenceOutput()
    const { cacheClean } = await import('./bin.js')

    await expect(cacheClean()).resolves.toBeUndefined()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import type { GlobalConfig } from '@sandboxpm/config'

// install() always builds `new SandboxRunner(new Dockerode(), ...)` even when no
// package has install scripts. Our fixture packages never declare scripts, so
// scriptPrompt.promptAll([]) returns immediately without ever touching the runner
// (see packages/scripts/src/index.test.ts "returns empty array for no scripts") —
// a stub class is enough to keep install() from touching a real Docker daemon.
vi.mock('dockerode', () => ({ default: class FakeDockerode {} }))

// Redirect the global store/cache/reports dirs into our per-test tmpDir instead of
// the real ~/.sandboxpm. Plain function (not vi.fn()) so vi.restoreAllMocks() in
// afterEach — which only rewinds real mocks/spies — never resets it back to a no-op.
let currentGlobalConfig: GlobalConfig = { storeDir: '', cacheDir: '', reportsDir: '' }

// getHostPlatform() caches its result in a module-level variable computed from the
// real process.platform — overridable here so the "host is not Linux" branch in
// install()'s step 2b (fetching sandbox-platform optional deps) can be exercised
// deterministically on any CI runner OS, not just when the dev machine happens to
// be non-Linux. Defaults to passing through to the real implementation.
let hostPlatformOverride: { os: string; cpu: string; libc?: string } | undefined

vi.mock('@sandboxpm/config', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown> & {
    getHostPlatform: () => { os: string; cpu: string; libc?: string }
  }
  return {
    ...original,
    loadGlobalConfig: async () => currentGlobalConfig,
    getHostPlatform: () => hostPlatformOverride ?? original.getHostPlatform(),
  }
})

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-cli-install-test-'))
  currentGlobalConfig = {
    storeDir: path.join(tmpDir, 'store'),
    cacheDir: path.join(tmpDir, 'cache'),
    reportsDir: path.join(tmpDir, 'reports'),
  }
  hostPlatformOverride = undefined
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writePackageJson(dir: string, content: object): Promise<void> {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

// ─── Fake registry + tarball fixtures ──────────────────────────────────────────
//
// Combines the fetcher test suite's real-gzipped-tarball-over-a-mocked-fetch idea
// with the resolver test suite's packument-keyed-by-name registry, so the real
// Resolver/Fetcher/Linker/CASStore classes run for real against a temp dir — only
// global.fetch is mocked.

interface VersionDef {
  deps?: Record<string, string>
}

// The 'tar' package that can WRITE archives is only a dependency of
// @sandboxpm/fetcher, not @sandboxpm/cli — and Fetcher itself extracts with it
// fine (resolved from fetcher's own node_modules at runtime). To build the fixture
// tarball here without adding a new dependency, hand-roll a minimal single-file
// USTAR entry (the same format `tar.extract` reads) and gzip it with the stdlib.
function makeUstarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 'utf8')
  buf.write('0000644\0', 100, 'utf8')     // mode
  buf.write('0000000\0', 108, 'utf8')     // uid
  buf.write('0000000\0', 116, 'utf8')     // gid
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8') // size
  buf.write('00000000000\0', 136, 'utf8') // mtime
  buf.write('        ', 148, 'utf8')      // checksum placeholder
  buf.write('0', 156, 'utf8')             // typeflag: regular file
  buf.write('ustar\0', 257, 'utf8')       // magic
  buf.write('00', 263, 'utf8')            // ustar version

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
  chunks.push(Buffer.alloc(1024)) // two zero blocks mark the archive end
  return zlib.gzipSync(Buffer.concat(chunks))
}

async function makeTarball(dir: string, uniqueId: string): Promise<{ tgzPath: string; integrity: string }> {
  // 'package/...' mirrors real npm tarballs — Fetcher extracts with strip:1.
  const buf = makeTarGz([{ name: 'package/index.js', content: `module.exports = ${JSON.stringify(uniqueId)}\n` }])
  const tgzPath = path.join(dir, `tgz-${crypto.randomBytes(4).toString('hex')}.tgz`)
  await fs.writeFile(tgzPath, buf)
  const integrity = `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`
  return { tgzPath, integrity }
}

/** Builds one packument (with a real per-version tarball) per name/version in `defs`. */
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
        scripts: {}, // no fixture package ever has install scripts
      }
    }
    const latest = Object.keys(versions).sort().at(-1) as string
    packuments[name] = { name, versions: versionsObj, 'dist-tags': { latest } }
  }

  return { packuments, tarballs }
}

/**
 * Serves both endpoints the real classes hit:
 *  - Resolver.fetchPackument: GET .../{name}            → full packument
 *  - Fetcher.fetchPackumentVersion: GET .../{name}/{ver} → single-version packument
 *  - tarball download: any URL ending in .tgz            → real gzip stream
 */
function installFetchMock(packuments: Record<string, any>, tarballs: Map<string, string>) {
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

    if (parts.length === 1) {
      // Resolver.fetchPackument — full packument
      return { ok: true, status: 200, json: async () => packument }
    }

    // Fetcher.fetchPackumentVersion — single-version packument
    const version = parts[1]
    const pv = version ? packument.versions[version] : undefined
    if (!pv) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    return { ok: true, status: 200, json: async () => pv }
  })
}

function silenceOutput() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
}

// ─── 1. install() — full success path ──────────────────────────────────────────

describe('install — success path', () => {
  it('resolves, downloads, links, and writes a lockfile with no install scripts', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, {
      'pkg-a': { '1.0.0': {} },
      'pkg-b': { '1.0.0': { deps: { 'pkg-a': '^1.0.0' } } },
    })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-b': '^1.0.0' } })

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir })

    expect(exitSpy).not.toHaveBeenCalled()

    const lockContent = JSON.parse(await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8'))
    expect(lockContent.packages['pkg-a@1.0.0']).toBeDefined()
    expect(lockContent.packages['pkg-b@1.0.0']).toBeDefined()

    // Direct dep symlinked into the project root node_modules
    await expect(fs.access(path.join(tmpDir, 'node_modules', 'pkg-b'))).resolves.toBeUndefined()
    // Files actually landed in the CAS store
    const storeFiles = await fs.readdir(path.join(tmpDir, 'store'))
    expect(storeFiles.length).toBeGreaterThan(0)
  })

  it('fetches sandbox-platform optional deps for scripted packages when the host is not Linux', async () => {
    // This block only runs when getHostPlatform() reports a non-Linux host — real
    // on a Windows/macOS dev box, but never true on Linux CI unless stubbed here.
    hostPlatformOverride = { os: 'darwin', cpu: 'x64' }

    const { packuments, tarballs } = await setupRegistry(tmpDir, {
      'pkg-with-script': { '1.0.0': { deps: {} } },
      'esbuild-linux-x64': { '1.0.0': {} },
    })
    // setupRegistry always builds bare packuments with no scripts/optionalDependencies —
    // patch in what this test actually needs.
    packuments['pkg-with-script'].versions['1.0.0'].scripts = { postinstall: 'node install.js' }
    packuments['pkg-with-script'].versions['1.0.0'].optionalDependencies = { 'esbuild-linux-x64': '1.0.0' }
    packuments['esbuild-linux-x64'].versions['1.0.0'].os = ['linux']
    packuments['esbuild-linux-x64'].versions['1.0.0'].cpu = ['x64']

    installFetchMock(packuments, tarballs)
    silenceOutput()

    // Blacklist the scripted package so ScriptPrompt auto-skips it without ever
    // touching SandboxRunner/Dockerode — this test is only about the optional-dep
    // fetch loop in install()'s step 2b, not the script-approval flow.
    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    const rc = defaultRc()
    rc.blacklist = ['pkg-with-script']
    await saveRc(tmpDir, rc)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-with-script': '^1.0.0' } })

    const { install } = await import('./bin.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await install({ cwd: tmpDir })
    expect(exitSpy).not.toHaveBeenCalled()

    // The sandbox-platform dep was fetched even though the host (darwin) would
    // normally filter it out of the main resolve/fetch pass.
    const lockContent = JSON.parse(await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8'))
    expect(lockContent.packages['esbuild-linux-x64@1.0.0']).toBeDefined()
  })
})

// ─── 2. install() — fresh lockfile ──────────────────────────────────────────────

describe('install — fresh lockfile', () => {
  it('reuses the lockfile without re-resolving from package.json', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {} } })
    const fetchMock = installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-a': '^1.0.0' } })

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir }) // writes sandboxpm.lock

    const callsBefore = fetchMock.mock.calls.length
    await install({ cwd: tmpDir }) // should read the fresh lockfile instead

    // A full-packument request is exactly one path segment after the registry host
    // (Resolver.fetchPackument); the per-version/tarball URLs Fetcher still hits
    // have more segments, so this only catches a real re-resolve.
    const fullPackumentCalls = fetchMock.mock.calls
      .slice(callsBefore)
      .filter(([reqUrl]) => /^https:\/\/registry\.npmjs\.org\/[^/]+$/.test(String(reqUrl)))
    expect(fullPackumentCalls).toHaveLength(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

// ─── 3. install() — stale lockfile ──────────────────────────────────────────────

describe('install — stale lockfile', () => {
  async function writeStaleLock(packuments: Record<string, any>) {
    const staleLock = {
      lockfileVersion: 1,
      sandboxpmVersion: '0.1.0',
      packages: {
        'pkg-a@1.0.0': {
          resolved: packuments['pkg-a'].versions['1.0.0'].dist.tarball,
          integrity: packuments['pkg-a'].versions['1.0.0'].dist.integrity,
          dependencies: {},
        },
      },
    }
    await fs.writeFile(path.join(tmpDir, 'sandboxpm.lock'), JSON.stringify(staleLock, null, 2))
  }

  it('re-resolves when frozenLockfile is false', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {}, '2.0.0': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    // package.json now wants ^2.0.0 but the lockfile is pinned to 1.0.0 — stale
    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-a': '^2.0.0' } })
    await writeStaleLock(packuments)

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir, frozenLockfile: false })

    expect(exitSpy).not.toHaveBeenCalled()
    const lockContent = JSON.parse(await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8'))
    expect(lockContent.packages['pkg-a@2.0.0']).toBeDefined()
  })

  it('exits with code 1 when frozenLockfile is true and the lockfile is stale', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {}, '2.0.0': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-a': '^2.0.0' } })
    await writeStaleLock(packuments)

    const { install } = await import('./bin.js')
    // process.exit is mocked to not actually stop execution, so the function may
    // keep running past it and throw later (e.g. on an undefined tree) — same
    // pattern as the existing --frozen-lockfile test in bin.test.ts.
    await install({ cwd: tmpDir, frozenLockfile: true }).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ─── 4. install() — --prod ──────────────────────────────────────────────────────

describe('install — --prod', () => {
  it('skips devDependencies when --prod is set', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, {
      'pkg-a': { '1.0.0': {} },
      'dev-pkg': { '1.0.0': {} },
    })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, {
      name: 'test-app',
      dependencies: { 'pkg-a': '^1.0.0' },
      devDependencies: { 'dev-pkg': '^1.0.0' },
    })

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir, prod: true })

    expect(exitSpy).not.toHaveBeenCalled()

    const lockContent = JSON.parse(await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8'))
    expect(lockContent.packages['pkg-a@1.0.0']).toBeDefined()
    expect(lockContent.packages['dev-pkg@1.0.0']).toBeUndefined()

    await expect(fs.access(path.join(tmpDir, 'node_modules', 'dev-pkg'))).rejects.toThrow()
  })
})

// ─── 5. addPackages ──────────────────────────────────────────────────────────────

describe('addPackages', () => {
  it('adds a versioned package to dependencies and installs it', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.2.3': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: {} })

    const { addPackages } = await import('./bin.js')
    await expect(addPackages(['pkg-a@1.2.3'], { cwd: tmpDir })).resolves.toBeUndefined()

    const pkgJson = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkgJson.dependencies['pkg-a']).toBe('1.2.3')
  })

  it('adds to devDependencies when dev: true', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app' })

    const { addPackages } = await import('./bin.js')
    await expect(addPackages(['pkg-a@1.0.0'], { cwd: tmpDir, dev: true })).resolves.toBeUndefined()

    const pkgJson = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkgJson.devDependencies['pkg-a']).toBe('1.0.0')
  })
})

// ─── 6. removePackages ───────────────────────────────────────────────────────────

describe('removePackages', () => {
  it('removes the package from package.json, unlinks, and reinstalls without throwing', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-a': '^1.0.0' } })

    const { install, removePackages } = await import('./bin.js')
    await install({ cwd: tmpDir })
    await expect(fs.access(path.join(tmpDir, 'node_modules', 'pkg-a'))).resolves.toBeUndefined()

    await expect(removePackages(['pkg-a'], { cwd: tmpDir })).resolves.toBeUndefined()

    const pkgJson = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkgJson.dependencies['pkg-a']).toBeUndefined()
    await expect(fs.access(path.join(tmpDir, 'node_modules', 'pkg-a'))).rejects.toThrow()
  })
})

// ─── 7. update() — without --latest ─────────────────────────────────────────────

describe('update — without --latest', () => {
  it('deletes the lockfile and reinstalls within current ranges', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-a': '^1.0.0' } })

    const { install, update } = await import('./bin.js')
    await install({ cwd: tmpDir })
    const lockBefore = await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8')
    expect(lockBefore.length).toBeGreaterThan(0)

    await expect(update([], { cwd: tmpDir })).resolves.toBeUndefined()

    // update() unlinks the old lockfile then calls install() again, which recreates it
    const lockAfter = await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8')
    expect(JSON.parse(lockAfter).packages['pkg-a@1.0.0']).toBeDefined()
  })
})

// ─── 9. install() — package risk / blocklist ────────────────────────────────────

describe('install — package risk / blocklist', () => {
  it('aborts before any tarball download when a resolved package is in blockedPackages', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {} } })
    const fetchMock = installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    const rc = defaultRc()
    rc.blockedPackages = ['pkg-a']
    await saveRc(tmpDir, rc)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-a': '^1.0.0' } })

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir }).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    // No tarball was ever downloaded for the blocked package
    const tarballCalls = fetchMock.mock.calls.filter(([reqUrl]) => String(reqUrl).endsWith('.tgz'))
    expect(tarballCalls).toHaveLength(0)
    await expect(fs.access(path.join(tmpDir, 'node_modules', 'pkg-a'))).rejects.toThrow()
  })

  it('auto-continues past a typosquat-shaped dependency and writes a risk audit report when onPackageRisk is "continue"', async () => {
    // Interactive prompting itself is covered in isolation by
    // packages/scripts/src/risk-prompt.test.ts (mocking `inquirer` across the
    // cli -> scripts package boundary isn't reliable under pnpm's per-package
    // symlinked node_modules); this test exercises install()'s wiring instead —
    // the non-interactive "continue" policy path, plus the audit report write.
    const { packuments, tarballs } = await setupRegistry(tmpDir, { lodahs: { '1.0.0': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    const rc = defaultRc()
    rc.policies.onPackageRisk = 'continue'
    await saveRc(tmpDir, rc)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { lodahs: '^1.0.0' } })

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir })

    expect(exitSpy).not.toHaveBeenCalled()
    await expect(fs.access(path.join(tmpDir, 'node_modules', 'lodahs'))).resolves.toBeUndefined()

    const reportFiles = await fs.readdir(currentGlobalConfig.reportsDir)
    const riskReport = reportFiles.find(f => f.startsWith('risk-lodahs-'))
    expect(riskReport).toBeDefined()
    const reportContent = JSON.parse(
      await fs.readFile(path.join(currentGlobalConfig.reportsDir, riskReport as string), 'utf8')
    )
    expect(reportContent.decision).toBe('continue')
    expect(reportContent.reasons[0]).toContain('typosquat:lodash')
  })

  it('aborts without downloading when onPackageRisk is "abort"', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { lodahs: { '1.0.0': {} } })
    const fetchMock = installFetchMock(packuments, tarballs)
    silenceOutput()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const { saveRc, defaultRc } = await import('@sandboxpm/config')
    const rc = defaultRc()
    rc.policies.onPackageRisk = 'abort'
    await saveRc(tmpDir, rc)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { lodahs: '^1.0.0' } })

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir }).catch(() => {})

    expect(exitSpy).toHaveBeenCalledWith(1)
    const tarballCalls = fetchMock.mock.calls.filter(([reqUrl]) => String(reqUrl).endsWith('.tgz'))
    expect(tarballCalls).toHaveLength(0)
  })
})

// ─── 8. update() — with --latest ────────────────────────────────────────────────

describe('update — with --latest', () => {
  it('bumps a dependency range to the latest dist-tag and reinstalls', async () => {
    const { packuments, tarballs } = await setupRegistry(tmpDir, { 'pkg-a': { '1.0.0': {}, '2.5.0': {} } })
    installFetchMock(packuments, tarballs)
    silenceOutput()
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await writePackageJson(tmpDir, { name: 'test-app', dependencies: { 'pkg-a': '^1.0.0' } })

    const { install, update } = await import('./bin.js')
    await install({ cwd: tmpDir })

    await expect(update([], { cwd: tmpDir, latest: true })).resolves.toBeUndefined()

    const pkgJson = JSON.parse(await fs.readFile(path.join(tmpDir, 'package.json'), 'utf8'))
    expect(pkgJson.dependencies['pkg-a']).toBe('^2.5.0')

    const lockContent = JSON.parse(await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8'))
    expect(lockContent.packages['pkg-a@2.5.0']).toBeDefined()
  })
})

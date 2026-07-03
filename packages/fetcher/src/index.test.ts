import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as tar from 'tar'
import { CASStore } from '@sandboxpm/store'
import { Fetcher, buildInspectUrl } from './index.js'

let tmpDir: string
let storeDir: string
let store: CASStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-fetcher-test-'))
  storeDir = path.join(tmpDir, 'store')
  store = new CASStore(storeDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTarball(files: Record<string, string>): Promise<{ tgzPath: string; integrity: string }> {
  const srcDir = path.join(tmpDir, `pkg-src-${Date.now()}`)
  await fs.mkdir(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(srcDir, name)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }

  const tgzPath = path.join(tmpDir, `pkg-${Date.now()}.tgz`)
  await tar.create(
    { gzip: true, file: tgzPath, cwd: path.dirname(srcDir) },
    [path.basename(srcDir)]
  )

  // compute sha512 of the tgz and build integrity string
  const buf = await fs.readFile(tgzPath)
  const hash = crypto.createHash('sha512').update(buf).digest('base64')
  const integrity = `sha512-${hash}`

  return { tgzPath, integrity }
}

function mockFetch(tgzPath: string, integrity: string) {
  return vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: string) => {
    if (url.includes('registry.npmjs.org') && !url.endsWith('.tgz')) {
      // packument version endpoint
      const body: object = {
        name: 'fake-pkg',
        version: '1.0.0',
        dist: { tarball: 'http://localhost/fake-pkg-1.0.0.tgz', integrity },
        scripts: { postinstall: 'node install.js' },
        dependencies: {},
      }
      return {
        ok: true,
        json: async () => body,
        status: 200,
      }
    }

    // tarball endpoint
    const buf = await fs.readFile(tgzPath)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buf))
        controller.close()
      },
    })
    return { ok: true, status: 200, body: stream }
  })
}

// ─── buildInspectUrl ──────────────────────────────────────────────────────────

describe('buildInspectUrl', () => {
  it('extracts JS file from "node install.js"', () => {
    const url = buildInspectUrl('esbuild', '0.19.4', 'node install.js')
    expect(url).toBe('https://unpkg.com/esbuild@0.19.4/install.js')
  })

  it('extracts nested script path from "node scripts/post.mjs"', () => {
    const url = buildInspectUrl('pkg', '1.0.0', 'node scripts/post.mjs')
    expect(url).toBe('https://unpkg.com/pkg@1.0.0/scripts/post.mjs')
  })

  it('falls back to npmjs URL for non-node scripts', () => {
    const url = buildInspectUrl('pkg', '2.0.0', 'node-pre-gyp install')
    expect(url).toBe('https://www.npmjs.com/package/pkg?activeTab=code')
  })

  it('falls back to npmjs URL for shell commands', () => {
    const url = buildInspectUrl('pkg', '1.0.0', 'sh ./install.sh')
    expect(url).toBe('https://www.npmjs.com/package/pkg?activeTab=code')
  })
})

// ─── Fetcher ──────────────────────────────────────────────────────────────────

describe('Fetcher.fetchOne', () => {
  it('downloads, verifies integrity, stores files, and extracts scripts', async () => {
    const { tgzPath, integrity } = await makeTarball({
      'package/package.json': JSON.stringify({
        name: 'fake-pkg', version: '1.0.0',
        scripts: { postinstall: 'node install.js' },
      }),
      'package/index.js': 'module.exports = 42',
      'package/install.js': 'console.log("installed")',
    })

    mockFetch(tgzPath, integrity)

    const fetcher = new Fetcher(store, [{ url: 'https://registry.npmjs.org' }], { tmpDir })
    const result = await fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })

    expect(result.packageId).toEqual({ name: 'fake-pkg', version: '1.0.0' })
    expect(result.files.length).toBeGreaterThan(0)
    expect(result.scripts).toHaveLength(1)
    expect(result.scripts[0]?.lifecycle).toBe('postinstall')
    expect(result.scripts[0]?.inspectUrl).toContain('unpkg.com')

    // files should be in store
    for (const f of result.files) {
      expect(await store.has(f.hash)).toBe(true)
    }
  })

  it('throws on SHA-512 integrity mismatch', async () => {
    const { tgzPath } = await makeTarball({ 'package/index.js': 'x' })
    const badIntegrity = 'sha512-' + Buffer.from('a'.repeat(64)).toString('base64')

    mockFetch(tgzPath, badIntegrity)

    const fetcher = new Fetcher(store, [], { tmpDir })
    await expect(
      fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })
    ).rejects.toThrow(/Integrity mismatch/)
  })
})

describe('Fetcher.fetchOne — fromCache', () => {
  it('returns fromCache=false on first fetch', async () => {
    const { tgzPath, integrity } = await makeTarball({
      'package/index.js': 'module.exports = 1',
    })
    mockFetch(tgzPath, integrity)

    const fetcher = new Fetcher(store, [], { tmpDir })
    const result = await fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })
    expect(result.fromCache).toBe(false)
  })

  it('returns fromCache=true on second fetch when all files are already in the store', async () => {
    const { tgzPath, integrity } = await makeTarball({
      'package/index.js': 'module.exports = 2',
    })
    mockFetch(tgzPath, integrity)

    const fetcher = new Fetcher(store, [], { tmpDir })

    // First fetch — populates store and writes manifest
    await fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })

    // Reset fetch spy so we can verify it is NOT called for the tarball on the second pass
    vi.restoreAllMocks()

    // Second mock: packument endpoint must still answer (to get the integrity value),
    // but tarball endpoint should never be hit
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: string) => {
      if (url.endsWith('.tgz')) throw new Error('Tarball should not be re-downloaded')
      return {
        ok: true,
        json: async () => ({
          name: 'fake-pkg', version: '1.0.0',
          dist: { tarball: 'http://localhost/fake-pkg-1.0.0.tgz', integrity },
          scripts: {},
          dependencies: {},
        }),
        status: 200,
      }
    })

    const result2 = await fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })
    expect(result2.fromCache).toBe(true)
    // Only the packument endpoint was called, never the tarball
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('.tgz'), expect.anything())
  })
})

describe('Fetcher.fetch (async iterable)', () => {
  it('yields results for multiple packages', async () => {
    const { tgzPath, integrity } = await makeTarball({
      'package/package.json': JSON.stringify({ name: 'a', version: '1.0.0' }),
      'package/index.js': 'module.exports = 1',
    })

    mockFetch(tgzPath, integrity)

    const fetcher = new Fetcher(store, [], { tmpDir, concurrency: 2 })
    const packages = [
      { name: 'a', version: '1.0.0' },
      { name: 'a', version: '1.0.0' },
    ]

    const results = []
    for await (const r of fetcher.fetch(packages)) {
      results.push(r)
    }
    expect(results).toHaveLength(2)
  })
})

describe('Fetcher.fetchOne — registry/network error branches', () => {
  it('throws when the registry responds not-ok for the packument request', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async () => {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    })

    const fetcher = new Fetcher(store, [], { tmpDir })
    await expect(
      fetcher.fetchOne({ name: 'missing-pkg', version: '1.0.0' })
    ).rejects.toThrow(/Registry fetch failed/)
  })

  it('throws when the tarball download responds not-ok', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: string) => {
      if (url.endsWith('.tgz')) {
        return { ok: false, status: 500, statusText: 'Server Error' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'fake-pkg', version: '1.0.0',
          dist: { tarball: 'http://localhost/fake-pkg-1.0.0.tgz' },
          scripts: {}, dependencies: {},
        }),
      }
    })

    const fetcher = new Fetcher(store, [], { tmpDir })
    await expect(
      fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })
    ).rejects.toThrow(/Failed to download tarball/)
  })

  it('throws when the tarball response has no body', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: string) => {
      if (url.endsWith('.tgz')) {
        return { ok: true, status: 200, body: undefined }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'fake-pkg', version: '1.0.0',
          dist: { tarball: 'http://localhost/fake-pkg-1.0.0.tgz' },
          scripts: {}, dependencies: {},
        }),
      }
    })

    const fetcher = new Fetcher(store, [], { tmpDir })
    await expect(
      fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })
    ).rejects.toThrow(/Empty response body/)
  })
})

describe('Fetcher.fetchOne — download backpressure', () => {
  it('handles a large tarball response that exceeds the write stream buffer (drain path)', async () => {
    // A single-chunk response body larger than the fs write-stream's highWaterMark
    // forces writer.write() to return false, exercising the once('drain', pump) branch.
    const bigContent = crypto.randomBytes(500_000).toString('hex')
    const { tgzPath, integrity } = await makeTarball({ 'package/data.txt': bigContent })
    mockFetch(tgzPath, integrity)

    const fetcher = new Fetcher(store, [], { tmpDir })
    const result = await fetcher.fetchOne({ name: 'fake-pkg', version: '1.0.0' })
    expect(result.files.length).toBeGreaterThan(0)
  })
})

describe('Fetcher.fetch — platform filtering', () => {
  it('skips a package whose os constraint never matches the real test host, silently', async () => {
    const { tgzPath, integrity } = await makeTarball({
      'package/package.json': JSON.stringify({ name: 'a', version: '1.0.0' }),
      'package/index.js': 'module.exports = 1',
    })

    const fetchSpy = mockFetch(tgzPath, integrity)

    const fetcher = new Fetcher(store, [], { tmpDir, concurrency: 2 })
    const packages = [
      { name: 'a', version: '1.0.0' },                          // no constraint — always matches
      { name: 'never-matches', version: '1.0.0', os: ['zos'] },  // z/OS — never the real test host
    ]

    const warnSpy = vi.spyOn(console, 'warn')
    const errorSpy = vi.spyOn(console, 'error')

    const results = []
    for await (const r of fetcher.fetch(packages)) {
      results.push(r)
    }

    expect(results).toHaveLength(1)
    expect(results[0]?.packageId.name).toBe('a')
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('never-matches'), expect.anything())
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

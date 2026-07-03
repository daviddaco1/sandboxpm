import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Node 24 ESM namespace properties are non-configurable; spread into a plain
// object so vi.spyOn can replace individual methods.
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return { ...actual }
})

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { CASStore, hashFile } from '@sandboxpm/store'
import type { ResolvedTree, ResolvedPackage, DependencyRange } from '@sandboxpm/resolver'
import type { FetchResult, FileMapping } from '@sandboxpm/fetcher'
import { Linker } from './index.js'

let tmpDir: string
let storeDir: string
let store: CASStore
let linker: Linker

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-linker-test-'))
  storeDir = path.join(tmpDir, 'store')
  store = new CASStore(storeDir)
  linker = new Linker(store)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function storeFile(content: string): Promise<{ hash: string; size: number }> {
  const src = path.join(tmpDir, `src-${Math.random().toString(36).slice(2)}.txt`)
  await fs.writeFile(src, content)
  const hash = await hashFile(src)
  await store.put(hash, src)
  await fs.rm(src)
  return { hash, size: Buffer.byteLength(content) }
}

function makeTree(opts: {
  packages: Array<{ name: string; version: string; deps?: Record<string, string>; optionalDeps?: Record<string, string> }>
  directDeps?: Array<{ name: string; range: string; type?: DependencyRange['type'] }>
}): ResolvedTree {
  const packages = new Map<string, ResolvedPackage>()
  for (const p of opts.packages) {
    packages.set(`${p.name}@${p.version}`, {
      name: p.name,
      version: p.version,
      resolved: `https://registry.npmjs.org/${p.name}/-/${p.name}-${p.version}.tgz`,
      integrity: `sha512-fake`,
      dependencies: p.deps ?? {},
      ...(p.optionalDeps ? { optionalDependencies: p.optionalDeps } : {}),
    })
  }
  const directDeps: DependencyRange[] = (opts.directDeps ?? opts.packages.map(p => ({
    name: p.name,
    range: `^${p.version}`,
    type: 'prod' as const,
  }))).map(d => ({ ...d, type: d.type ?? 'prod' }))

  return {
    root: tmpDir,
    packages,
    directDeps,
    lockfileHash: 'abc123',
  }
}

function makeFetchResults(
  packages: Array<{ name: string; version: string; files: Array<{ relativePath: string; hash: string; mode?: number; size?: number }> }>,
): Map<string, FetchResult> {
  const map = new Map<string, FetchResult>()
  for (const p of packages) {
    const files: FileMapping[] = p.files.map(f => ({
      hash: f.hash,
      relativePath: f.relativePath,
      mode: f.mode ?? 0o644,
      size: f.size ?? 0,
    }))
    map.set(`${p.name}@${p.version}`, {
      packageId: { name: p.name, version: p.version },
      files,
      scripts: [],
      fromCache: false,
    })
  }
  return map
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Linker.link — basic structure', () => {
  it('creates .sandboxpm/{name}@{version}/node_modules/{name}/ directory', async () => {
    const { hash } = await storeFile('module.exports = 1')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({ packages: [{ name: 'foo', version: '1.0.0' }] })
    const fetchResults = makeFetchResults([{
      name: 'foo', version: '1.0.0',
      files: [{ relativePath: 'index.js', hash }],
    }])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const sandboxpmPkgDir = path.join(projectDir, 'node_modules', '.sandboxpm', 'foo@1.0.0', 'node_modules', 'foo')
    const stat = await fs.stat(sandboxpmPkgDir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('hard-links files into package directory', async () => {
    const content = 'console.log("hello")'
    const { hash, size } = await storeFile(content)
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({ packages: [{ name: 'foo', version: '1.0.0' }] })
    const fetchResults = makeFetchResults([{
      name: 'foo', version: '1.0.0',
      files: [{ relativePath: 'index.js', hash, size }],
    }])

    const result = await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const linkedFile = path.join(projectDir, 'node_modules', '.sandboxpm', 'foo@1.0.0', 'node_modules', 'foo', 'index.js')
    const readContent = await fs.readFile(linkedFile, 'utf8')
    expect(readContent).toBe(content)
    expect(result.hardLinksCreated).toBe(1)
    expect(result.bytesFromStore).toBe(size)

    // Verify it's actually a hard link (same inode as store entry)
    const storePath = path.join(storeDir, hash)
    const storedStat = await fs.stat(storePath)
    const linkedStat = await fs.stat(linkedFile)
    expect(linkedStat.ino).toBe(storedStat.ino)
  })

  it('creates a symlink in root node_modules for direct deps', async () => {
    const { hash } = await storeFile('x')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({ packages: [{ name: 'bar', version: '2.0.0' }] })
    const fetchResults = makeFetchResults([{
      name: 'bar', version: '2.0.0',
      files: [{ relativePath: 'index.js', hash }],
    }])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const symlinkPath = path.join(projectDir, 'node_modules', 'bar')
    const stat = await fs.lstat(symlinkPath)
    expect(stat.isSymbolicLink()).toBe(true)
  })

  it('returns correct linkedPackages count', async () => {
    const { hash } = await storeFile('a')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({
      packages: [
        { name: 'a', version: '1.0.0' },
        { name: 'b', version: '1.0.0' },
      ],
    })
    const fetchResults = makeFetchResults([
      { name: 'a', version: '1.0.0', files: [{ relativePath: 'a.js', hash }] },
      { name: 'b', version: '1.0.0', files: [{ relativePath: 'b.js', hash }] },
    ])

    const result = await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })
    expect(result.linkedPackages).toBe(2)
  })
})

describe('Linker.link — transitive dependency symlinks', () => {
  it('creates cross-links for transitive deps inside each package node_modules', async () => {
    const { hash } = await storeFile('dep')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    // express depends on accepts
    const tree = makeTree({
      packages: [
        { name: 'express', version: '4.18.2', deps: { accepts: '1.3.8' } },
        { name: 'accepts', version: '1.3.8', deps: {} },
      ],
      directDeps: [{ name: 'express', range: '^4.0.0', type: 'prod' }],
    })
    const fetchResults = makeFetchResults([
      { name: 'express', version: '4.18.2', files: [{ relativePath: 'index.js', hash }] },
      { name: 'accepts', version: '1.3.8', files: [{ relativePath: 'index.js', hash }] },
    ])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    // accepts should be symlinked inside express's own node_modules
    const crossLink = path.join(
      projectDir, 'node_modules', '.sandboxpm', 'express@4.18.2', 'node_modules', 'accepts'
    )
    const stat = await fs.lstat(crossLink)
    expect(stat.isSymbolicLink()).toBe(true)
  })
})

describe('Linker.link — optionalDependencies (platform variants)', () => {
  it('symlinks an optional dep into its parent node_modules when it was fetched', async () => {
    const { hash } = await storeFile('native binary stub')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    // native-pkg optionally depends on native-pkg-win32-x64, and it matched this host
    const tree = makeTree({
      packages: [
        { name: 'native-pkg', version: '1.0.0', optionalDeps: { 'native-pkg-win32-x64': '1.0.0' } },
        { name: 'native-pkg-win32-x64', version: '1.0.0' },
      ],
      directDeps: [{ name: 'native-pkg', range: '^1.0.0', type: 'prod' }],
    })
    const fetchResults = makeFetchResults([
      { name: 'native-pkg', version: '1.0.0', files: [{ relativePath: 'index.js', hash }] },
      { name: 'native-pkg-win32-x64', version: '1.0.0', files: [{ relativePath: 'binding.node', hash }] },
    ])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const crossLink = path.join(
      projectDir, 'node_modules', '.sandboxpm', 'native-pkg@1.0.0', 'node_modules', 'native-pkg-win32-x64'
    )
    const stat = await fs.lstat(crossLink)
    expect(stat.isSymbolicLink()).toBe(true)
  })

  it('creates no dangling symlink for an optional dep that was resolved but never fetched (wrong platform)', async () => {
    const { hash } = await storeFile('index')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    // native-pkg-linux-x64 is in the resolved tree (multi-platform lock) but this
    // "host" never fetched it — simulates the fetcher's platform filter at work.
    const tree = makeTree({
      packages: [
        { name: 'native-pkg', version: '1.0.0', optionalDeps: { 'native-pkg-linux-x64': '1.0.0' } },
        { name: 'native-pkg-linux-x64', version: '1.0.0' },
      ],
      directDeps: [{ name: 'native-pkg', range: '^1.0.0', type: 'prod' }],
    })
    const fetchResults = makeFetchResults([
      { name: 'native-pkg', version: '1.0.0', files: [{ relativePath: 'index.js', hash }] },
      // native-pkg-linux-x64 deliberately has no entry here
    ])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const crossLink = path.join(
      projectDir, 'node_modules', '.sandboxpm', 'native-pkg@1.0.0', 'node_modules', 'native-pkg-linux-x64'
    )
    await expect(fs.lstat(crossLink)).rejects.toThrow(/ENOENT/)
  })

  it('creates no root symlink for a direct optional dep that was never fetched', async () => {
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({
      packages: [{ name: 'never-fetched', version: '1.0.0' }],
      directDeps: [{ name: 'never-fetched', range: '^1.0.0', type: 'optional' }],
    })
    const fetchResults = makeFetchResults([]) // nothing fetched at all

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const symlinkPath = path.join(projectDir, 'node_modules', 'never-fetched')
    await expect(fs.lstat(symlinkPath)).rejects.toThrow(/ENOENT/)
  })
})

describe('Linker.link — dev deps', () => {
  it('excludes dev deps from root symlinks when includeDevDependencies=false', async () => {
    const { hash } = await storeFile('dev')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({
      packages: [{ name: 'jest', version: '29.0.0' }],
      directDeps: [{ name: 'jest', range: '^29.0.0', type: 'dev' }],
    })
    const fetchResults = makeFetchResults([{
      name: 'jest', version: '29.0.0',
      files: [{ relativePath: 'index.js', hash }],
    }])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: false })

    const symlinkPath = path.join(projectDir, 'node_modules', 'jest')
    await expect(fs.lstat(symlinkPath)).rejects.toThrow(/ENOENT/)
  })
})

describe('Linker._linkBins — chmod +x', () => {
  it('marks bin target executable after linking', async () => {
    const pkgJsonContent = JSON.stringify({
      name: 'mycli', version: '1.0.0', bin: { mycli: './bin/cli.js' },
    })
    const { hash: pkgJsonHash } = await storeFile(pkgJsonContent)
    const { hash: binHash } = await storeFile('#!/usr/bin/env node\nconsole.log("hi")')

    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({ packages: [{ name: 'mycli', version: '1.0.0' }] })
    const fetchResults = makeFetchResults([{
      name: 'mycli', version: '1.0.0',
      files: [
        { relativePath: 'package.json', hash: pkgJsonHash },
        { relativePath: 'bin/cli.js', hash: binHash },
      ],
    }])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const binTarget = path.join(
      projectDir, 'node_modules', '.sandboxpm', 'mycli@1.0.0', 'node_modules', 'mycli', 'bin', 'cli.js',
    )
    const stat = await fs.stat(binTarget)
    expect(stat.isFile()).toBe(true)
    // POSIX execute bits are not meaningful on Windows
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o111).not.toBe(0)
    }
  })
})

describe('Linker.link — unresolvable direct dep', () => {
  it('skips a direct dependency whose resolved version cannot be found in the tree', async () => {
    const { hash } = await storeFile('foo')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    // "missing-dep" is declared as a direct dep but never made it into tree.packages
    // (e.g. resolution dropped it) — _findVersion must return undefined for it.
    const tree = makeTree({
      packages: [{ name: 'foo', version: '1.0.0' }],
      directDeps: [
        { name: 'foo', range: '^1.0.0', type: 'prod' },
        { name: 'missing-dep', range: '^1.0.0', type: 'prod' },
      ],
    })
    const fetchResults = makeFetchResults([
      { name: 'foo', version: '1.0.0', files: [{ relativePath: 'index.js', hash }] },
    ])

    const result = await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

    const missingSymlink = path.join(projectDir, 'node_modules', 'missing-dep')
    await expect(fs.lstat(missingSymlink)).rejects.toThrow(/ENOENT/)
    expect(result.symlinksCreated).toBeGreaterThanOrEqual(1)
  })
})

describe('Linker._ensureSymlink — non-Windows platform', () => {
  it('calls fs.symlink without a junction/file type argument on non-win32 platforms', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const { hash } = await storeFile('posix content')
      const projectDir = path.join(tmpDir, 'project')
      await fs.mkdir(projectDir)

      const tree = makeTree({ packages: [{ name: 'foo', version: '1.0.0' }] })
      const fetchResults = makeFetchResults([{
        name: 'foo', version: '1.0.0',
        files: [{ relativePath: 'index.js', hash }],
      }])

      const symlinkSpy = vi.spyOn(fs, 'symlink').mockResolvedValue(undefined)

      await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

      expect(symlinkSpy).toHaveBeenCalled()
      const call = symlinkSpy.mock.calls[0]
      // non-win32 branch invokes fs.symlink(target, symlinkPath) — no third "type" arg
      expect(call).toHaveLength(2)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

describe('Linker._ensureSymlink / _linkBins — Windows platform', () => {
  it('uses junction for directory symlinks, falls back to a .cmd shim on EPERM for bin files', async () => {
    // Real dev machines that happen to run on Windows exercise this branch "for
    // free" just by running the suite; Linux CI never does unless process.platform
    // is stubbed here explicitly — without this test the win32 branch in
    // _ensureSymlink/_linkBins is only ever covered on a Windows dev box.
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const pkgJsonContent = JSON.stringify({
        name: 'wincli', version: '1.0.0', bin: { wincli: './bin/cli.js' },
      })
      const { hash: pkgJsonHash } = await storeFile(pkgJsonContent)
      const { hash: binHash } = await storeFile('#!/usr/bin/env node\nconsole.log("hi")')

      const projectDir = path.join(tmpDir, 'project')
      await fs.mkdir(projectDir)

      const tree = makeTree({ packages: [{ name: 'wincli', version: '1.0.0' }] })
      const fetchResults = makeFetchResults([{
        name: 'wincli', version: '1.0.0',
        files: [
          { relativePath: 'package.json', hash: pkgJsonHash },
          { relativePath: 'bin/cli.js', hash: binHash },
        ],
      }])

      // The package-directory symlink (isDir:true → 'junction') should succeed
      // normally; only the bin-file symlink (isDir:false → 'file') simulates the
      // "no Developer Mode / not elevated" EPERM Windows throws for file symlinks.
      const symlinkSpy = vi.spyOn(fs, 'symlink').mockImplementation(async (_target, _link, type) => {
        if (type === 'file') {
          const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
      })

      await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })

      const junctionCall = symlinkSpy.mock.calls.find(c => c[2] === 'junction')
      const fileCall = symlinkSpy.mock.calls.find(c => c[2] === 'file')
      expect(junctionCall).toBeDefined()
      expect(fileCall).toBeDefined()

      const shimPath = path.join(projectDir, 'node_modules', '.bin', 'wincli.cmd')
      const shim = await fs.readFile(shimPath, 'utf8')
      expect(shim).toContain('@node')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

describe('Linker._linkBins — non-EPERM error propagation', () => {
  it('rethrows a bin symlink error that is not a Windows EPERM', async () => {
    const pkgJsonContent = JSON.stringify({
      name: 'mycli', version: '1.0.0', bin: { mycli: './bin/cli.js' },
    })
    const { hash: pkgJsonHash } = await storeFile(pkgJsonContent)
    const { hash: binHash } = await storeFile('#!/usr/bin/env node\nconsole.log("hi")')

    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    // Make mycli a "dev" direct dep so Step 2 (root symlink) skips it via
    // includeDevDependencies:false, leaving _linkBins's symlink call (Step 4)
    // as the only fs.symlink invocation in this run.
    const tree = makeTree({
      packages: [{ name: 'mycli', version: '1.0.0' }],
      directDeps: [{ name: 'mycli', range: '^1.0.0', type: 'dev' }],
    })
    const fetchResults = makeFetchResults([{
      name: 'mycli', version: '1.0.0',
      files: [
        { relativePath: 'package.json', hash: pkgJsonHash },
        { relativePath: 'bin/cli.js', hash: binHash },
      ],
    }])

    const boom = Object.assign(new Error('boom'), { code: 'EACCES' })
    vi.spyOn(fs, 'symlink').mockRejectedValueOnce(boom)

    await expect(
      linker.link(tree, fetchResults, { projectDir, includeDevDependencies: false })
    ).rejects.toThrow('boom')
  })
})

describe('Linker.unlink — no node_modules', () => {
  it('is a no-op when node_modules does not exist at all', async () => {
    const projectDir = path.join(tmpDir, 'never-linked')
    await fs.mkdir(projectDir, { recursive: true })
    await expect(linker.unlink(projectDir)).resolves.toBeUndefined()
  })
})

describe('Linker.unlink', () => {
  it('removes .sandboxpm dir and root symlinks', async () => {
    const { hash } = await storeFile('x')
    const projectDir = path.join(tmpDir, 'project')
    await fs.mkdir(projectDir)

    const tree = makeTree({ packages: [{ name: 'foo', version: '1.0.0' }] })
    const fetchResults = makeFetchResults([{
      name: 'foo', version: '1.0.0', files: [{ relativePath: 'index.js', hash }],
    }])

    await linker.link(tree, fetchResults, { projectDir, includeDevDependencies: true })
    await linker.unlink(projectDir)

    const sandboxpmDir = path.join(projectDir, 'node_modules', '.sandboxpm')
    await expect(fs.stat(sandboxpmDir)).rejects.toThrow(/ENOENT/)

    const symlink = path.join(projectDir, 'node_modules', 'foo')
    await expect(fs.lstat(symlink)).rejects.toThrow(/ENOENT/)
  })
})

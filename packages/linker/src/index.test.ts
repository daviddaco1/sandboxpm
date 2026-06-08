import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  packages: Array<{ name: string; version: string; deps?: Record<string, string> }>
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
    // File should have at least one executable bit set
    expect(stat.mode & 0o111).not.toBe(0)
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

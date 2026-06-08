import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Resolver } from './index.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-resolver-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── Mock registry ────────────────────────────────────────────────────────────

function makePackument(name: string, versions: Record<string, { deps?: Record<string, string>; scripts?: Record<string, string> }>) {
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
      scripts: opts.scripts ?? {},
    }
  }
  const latestVersion = Object.keys(versions).sort().at(-1) ?? '1.0.0'
  return {
    name,
    versions: versionsObj,
    'dist-tags': { latest: latestVersion },
  }
}

const REGISTRY: Record<string, ReturnType<typeof makePackument>> = {
  express: makePackument('express', {
    '4.18.2': { deps: { 'body-parser': '^1.20.0', accepts: '~1.3.8' } },
    '3.0.0': { deps: {} },
  }),
  'body-parser': makePackument('body-parser', {
    '1.20.2': { deps: { bytes: '3.1.2' } },
  }),
  accepts: makePackument('accepts', {
    '1.3.8': { deps: { 'mime-types': '~2.1.34' } },
  }),
  'mime-types': makePackument('mime-types', {
    '2.1.35': { deps: {} },
  }),
  bytes: makePackument('bytes', {
    '3.1.2': { deps: {} },
  }),
  lodash: makePackument('lodash', {
    '3.10.1': { deps: {} },
    '4.17.21': { deps: {} },
  }),
  'pkg-with-script': makePackument('pkg-with-script', {
    '1.0.0': { scripts: { postinstall: 'node install.js' }, deps: {} },
  }),
}

function mockRegistry() {
  vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
    const urlStr = String(url)
    const name = urlStr.replace('https://registry.npmjs.org/', '')
    const packument = REGISTRY[name]
    if (!packument) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => packument,
    } as Response
  })
}

async function writePackageJson(dir: string, content: object) {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(content, null, 2))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Resolver.selectVersion', () => {
  it('picks highest satisfying version', () => {
    const resolver = new Resolver()
    const p = makePackument('express', { '4.18.2': {}, '4.17.0': {}, '3.0.0': {} })
    expect(resolver.selectVersion(p as never, '^4.0.0')).toBe('4.18.2')
  })

  it('resolves dist-tags', () => {
    const resolver = new Resolver()
    const p = makePackument('pkg', { '1.2.3': {} })
    expect(resolver.selectVersion(p as never, 'latest')).toBe('1.2.3')
  })

  it('returns null when no version satisfies range', () => {
    const resolver = new Resolver()
    const p = makePackument('pkg', { '1.0.0': {} })
    expect(resolver.selectVersion(p as never, '^5.0.0')).toBeNull()
  })
})

describe('Resolver.resolve', () => {
  it('resolves direct + transitive dependencies', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, {
      name: 'my-app',
      dependencies: { express: '^4.0.0' },
    })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    expect(tree.packages.has('express@4.18.2')).toBe(true)
    expect(tree.packages.has('body-parser@1.20.2')).toBe(true)
    expect(tree.packages.has('accepts@1.3.8')).toBe(true)
    expect(tree.packages.has('mime-types@2.1.35')).toBe(true)
    expect(tree.packages.has('bytes@3.1.2')).toBe(true)
  })

  it('deduplicates packages that appear multiple times in the tree', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, {
      dependencies: { express: '^4.0.0', 'body-parser': '^1.20.0' },
    })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    // body-parser appears as direct dep and as transitive dep of express
    // should only appear once
    const bodyParsers = [...tree.packages.keys()].filter(k => k.startsWith('body-parser@'))
    expect(bodyParsers).toHaveLength(1)
  })

  it('writes a deterministic lockfile', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, {
      dependencies: { express: '^4.0.0' },
    })

    const resolver = new Resolver()
    const tree1 = await resolver.resolve(tmpDir)

    // Resolve again — lockfile hash should be the same
    const resolver2 = new Resolver()
    const tree2 = await resolver2.resolve(tmpDir)

    expect(tree1.lockfileHash).toBe(tree2.lockfileHash)
  })

  it('includes scripts in lockfile entries', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, {
      dependencies: { 'pkg-with-script': '^1.0.0' },
    })

    const resolver = new Resolver()
    await resolver.resolve(tmpDir)

    const lockContent = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8')
    )
    const entry = lockContent.packages['pkg-with-script@1.0.0']
    expect(entry?.scripts?.postinstall).toBe('node install.js')
  })

  it('throws when package version is not satisfiable', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, {
      dependencies: { express: '^99.0.0' },
    })

    const resolver = new Resolver()
    await expect(resolver.resolve(tmpDir)).rejects.toThrow(/No version.*express.*satisfies/)
  })
})

describe('Resolver.resolve — includeDev option', () => {
  it('excludes devDependencies when includeDev: false', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, {
      dependencies: { express: '^4.0.0' },
      devDependencies: { jest: '29.0.0' },
    })

    // Add jest to mock registry so it can be resolved if includeDev is true
    const REGISTRY_WITH_JEST = {
      ...REGISTRY,
      jest: makePackument('jest', { '29.0.0': {} }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = REGISTRY_WITH_JEST[name as keyof typeof REGISTRY_WITH_JEST]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    const resolver = new Resolver([], { includeDev: false })
    const tree = await resolver.resolve(tmpDir)

    // prod deps present
    expect(tree.packages.has('express@4.18.2')).toBe(true)
    // dev dep absent
    expect([...tree.packages.keys()].some(k => k.startsWith('jest@'))).toBe(false)
  })

  it('includes devDependencies by default (includeDev unset)', async () => {
    mockRegistry()
    const REGISTRY_WITH_JEST = {
      ...REGISTRY,
      jest: makePackument('jest', { '29.0.0': {} }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = REGISTRY_WITH_JEST[name as keyof typeof REGISTRY_WITH_JEST]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, {
      dependencies: { bytes: '^3.1.0' },
      devDependencies: { jest: '29.0.0' },
    })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    expect([...tree.packages.keys()].some(k => k.startsWith('jest@'))).toBe(true)
  })
})

describe('Resolver.resolve — peerDependencies', () => {
  it('warns but does not throw for unsatisfiable peer deps', async () => {
    const REGISTRY_WITH_PEER = {
      ...REGISTRY,
      'has-peer': makePackument('has-peer', {
        '1.0.0': { deps: {} },
      }),
    }
    // Inject peerDependencies manually into the packument
    const hasPeerPv = REGISTRY_WITH_PEER['has-peer']?.versions['1.0.0'] as Record<string, unknown>
    if (hasPeerPv) {
      hasPeerPv['peerDependencies'] = { react: '^99.0.0' } // impossible to satisfy
    }

    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = REGISTRY_WITH_PEER[name as keyof typeof REGISTRY_WITH_PEER]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, {
      dependencies: { 'has-peer': '^1.0.0' },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)  // must NOT throw

    expect(tree.packages.has('has-peer@1.0.0')).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('peer dep warning'))
  })
})

describe('Resolver.resolve — version conflicts (pnpm-style nested)', () => {
  it('includes both conflicting versions when parents need incompatible ranges', async () => {
    // pkg-a needs lodash@^3, pkg-b needs lodash@^4
    // Both versions must appear in the resolved tree so each parent gets the
    // version it requires (nested resolution, not flat dedup).
    const CONFLICT_REGISTRY = {
      ...REGISTRY,
      'pkg-a': makePackument('pkg-a', { '1.0.0': { deps: { lodash: '^3.0.0' } } }),
      'pkg-b': makePackument('pkg-b', { '1.0.0': { deps: { lodash: '^4.0.0' } } }),
    }

    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = CONFLICT_REGISTRY[name as keyof typeof CONFLICT_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, {
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' },
    })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    // Both pkg-a and pkg-b must be resolved
    expect(tree.packages.has('pkg-a@1.0.0')).toBe(true)
    expect(tree.packages.has('pkg-b@1.0.0')).toBe(true)

    // lodash@3.10.1 (for pkg-a's ^3) AND lodash@4.17.21 (for pkg-b's ^4) both present
    expect(tree.packages.has('lodash@3.10.1')).toBe(true)
    expect(tree.packages.has('lodash@4.17.21')).toBe(true)
  })
})

describe('Resolver.resolveFromLock', () => {
  it('loads a lockfile without calling the registry', async () => {
    const spyFetch = vi.spyOn(global, 'fetch' as keyof typeof global)
    const lockfile = {
      lockfileVersion: 1,
      sandboxpmVersion: '0.1.0',
      packages: {
        'express@4.18.2': {
          resolved: 'https://registry.npmjs.org/express/-/express-4.18.2.tgz',
          integrity: 'sha512-abc==',
          dependencies: {},
        },
      },
    }
    const lockPath = path.join(tmpDir, 'sandboxpm.lock')
    await fs.writeFile(lockPath, JSON.stringify(lockfile))

    const resolver = new Resolver()
    const tree = await resolver.resolveFromLock(lockPath)

    expect(spyFetch).not.toHaveBeenCalled()
    expect(tree.packages.has('express@4.18.2')).toBe(true)
    expect(tree.packages.get('express@4.18.2')?.version).toBe('4.18.2')
  })
})

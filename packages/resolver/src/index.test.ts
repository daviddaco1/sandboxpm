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

function makePackument(name: string, versions: Record<string, {
  deps?: Record<string, string>
  optionalDeps?: Record<string, string>
  scripts?: Record<string, string>
  os?: string[]
  cpu?: string[]
  libc?: string[]
}>) {
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
      optionalDependencies: opts.optionalDeps ?? {},
      scripts: opts.scripts ?? {},
      ...(opts.os ? { os: opts.os } : {}),
      ...(opts.cpu ? { cpu: opts.cpu } : {}),
      ...(opts.libc ? { libc: opts.libc } : {}),
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

describe('Resolver.registryUrl (internal getter)', () => {
  it('strips a trailing slash from the configured registry url', () => {
    const resolver = new Resolver([{ url: 'https://custom.registry.io/' }])
    expect((resolver as unknown as { registryUrl: string }).registryUrl).toBe('https://custom.registry.io')
  })
})

describe('Resolver.fetchPackument — network-level failure', () => {
  it('warns but does not throw when an optional dependency fetch throws before responding', async () => {
    const PLATFORM_REGISTRY = { ...REGISTRY }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      if (name === 'unreachable-pkg') throw new Error('network down')
      const packument = PLATFORM_REGISTRY[name as keyof typeof PLATFORM_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, {
      dependencies: { express: '^4.0.0' },
      optionalDependencies: { 'unreachable-pkg': '^1.0.0' },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir) // must NOT throw

    expect(tree.packages.has('express@4.18.2')).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('optional dep warning: failed to fetch "unreachable-pkg"'))
  })

  it('throws when a required (non-optional, non-peer) dependency cannot be fetched at all', async () => {
    mockRegistry() // 'totally-unknown-pkg' is not in REGISTRY -> 404 for every registry attempt
    await writePackageJson(tmpDir, {
      dependencies: { 'totally-unknown-pkg': '^1.0.0' },
    })

    const resolver = new Resolver()
    await expect(resolver.resolve(tmpDir)).rejects.toThrow(/Registry.*404/)
  })
})

describe('Resolver.resolve — unsatisfiable version for an optional dependency that exists', () => {
  it('warns but does not throw when the optional dependency package exists but no version satisfies the range', async () => {
    const PLATFORM_REGISTRY = {
      ...REGISTRY,
      'native-pkg': makePackument('native-pkg', {
        '1.0.0': { optionalDeps: { lodash: '^99.0.0' } }, // lodash exists, but no v99
      }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = PLATFORM_REGISTRY[name as keyof typeof PLATFORM_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, { dependencies: { 'native-pkg': '^1.0.0' } })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir) // must NOT throw

    expect(tree.packages.has('native-pkg@1.0.0')).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no version of "lodash" satisfies'))
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

describe('Resolver.resolve — optionalDependencies (platform variants)', () => {
  it('resolves every platform variant into the lockfile, regardless of the test-runner\'s OS', async () => {
    const PLATFORM_REGISTRY = {
      ...REGISTRY,
      'native-pkg': makePackument('native-pkg', {
        '1.0.0': { optionalDeps: { 'native-pkg-win32-x64': '1.0.0', 'native-pkg-linux-x64': '1.0.0' } },
      }),
      'native-pkg-win32-x64': makePackument('native-pkg-win32-x64', {
        '1.0.0': { os: ['win32'], cpu: ['x64'] },
      }),
      'native-pkg-linux-x64': makePackument('native-pkg-linux-x64', {
        '1.0.0': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
      }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = PLATFORM_REGISTRY[name as keyof typeof PLATFORM_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, { dependencies: { 'native-pkg': '^1.0.0' } })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    expect(tree.packages.has('native-pkg-win32-x64@1.0.0')).toBe(true)
    expect(tree.packages.has('native-pkg-linux-x64@1.0.0')).toBe(true)

    const lockContent = JSON.parse(await fs.readFile(path.join(tmpDir, 'sandboxpm.lock'), 'utf8'))
    expect(lockContent.packages['native-pkg-win32-x64@1.0.0'].os).toEqual(['win32'])
    expect(lockContent.packages['native-pkg-linux-x64@1.0.0'].os).toEqual(['linux'])
    expect(lockContent.packages['native-pkg-linux-x64@1.0.0'].libc).toEqual(['glibc'])
  })

  it('warns but does not throw when an optional dependency 404s or is unsatisfiable', async () => {
    const PLATFORM_REGISTRY = {
      ...REGISTRY,
      'native-pkg': makePackument('native-pkg', {
        '1.0.0': { optionalDeps: { 'missing-native-pkg': '^1.0.0' } },
      }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = PLATFORM_REGISTRY[name as keyof typeof PLATFORM_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, { dependencies: { 'native-pkg': '^1.0.0' } })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir) // must NOT throw

    expect(tree.packages.has('native-pkg@1.0.0')).toBe(true)
    expect(tree.packages.get('native-pkg@1.0.0')?.optionalDependencies).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('optional dep warning'))
  })

  it('resolves a package\'s optionalDependencies map to exact versions', async () => {
    const PLATFORM_REGISTRY = {
      ...REGISTRY,
      'native-pkg': makePackument('native-pkg', {
        '1.0.0': { optionalDeps: { 'native-pkg-win32-x64': '^1.0.0' } },
      }),
      'native-pkg-win32-x64': makePackument('native-pkg-win32-x64', {
        '1.0.0': { os: ['win32'], cpu: ['x64'] },
      }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = PLATFORM_REGISTRY[name as keyof typeof PLATFORM_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, { dependencies: { 'native-pkg': '^1.0.0' } })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    expect(tree.packages.get('native-pkg@1.0.0')?.optionalDependencies).toEqual({
      'native-pkg-win32-x64': '1.0.0',
    })
  })

  it('does not throw when a root-level optionalDependency is unsatisfiable', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, {
      dependencies: { express: '^4.0.0' },
      optionalDependencies: { 'does-not-exist': '^1.0.0' },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir) // must NOT throw

    expect(tree.packages.has('express@4.18.2')).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('optional dep warning'))
  })

  it('round-trips os/cpu/libc through resolveFromLock without calling the registry', async () => {
    const spyFetch = vi.spyOn(global, 'fetch' as keyof typeof global)
    const lockfile = {
      lockfileVersion: 1,
      sandboxpmVersion: '0.1.0',
      packages: {
        'native-pkg-win32-x64@1.0.0': {
          resolved: 'https://registry.npmjs.org/native-pkg-win32-x64/-/native-pkg-win32-x64-1.0.0.tgz',
          integrity: 'sha512-abc==',
          os: ['win32'],
          cpu: ['x64'],
        },
        'native-pkg-linux-x64@1.0.0': {
          resolved: 'https://registry.npmjs.org/native-pkg-linux-x64/-/native-pkg-linux-x64-1.0.0.tgz',
          integrity: 'sha512-def==',
          os: ['linux'],
          cpu: ['x64'],
          libc: ['musl'],
        },
      },
    }
    const lockPath = path.join(tmpDir, 'sandboxpm.lock')
    await fs.writeFile(lockPath, JSON.stringify(lockfile))

    const resolver = new Resolver()
    const tree = await resolver.resolveFromLock(lockPath)

    expect(spyFetch).not.toHaveBeenCalled()
    expect(tree.packages.get('native-pkg-win32-x64@1.0.0')?.os).toEqual(['win32'])
    expect(tree.packages.get('native-pkg-linux-x64@1.0.0')?.libc).toEqual(['musl'])
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

    // Each parent's own dependency edge must point at the version that satisfies
    // ITS range, not whichever version happened to win the shared "lodash" dedup slot.
    expect(tree.packages.get('pkg-a@1.0.0')?.dependencies['lodash']).toBe('3.10.1')
    expect(tree.packages.get('pkg-b@1.0.0')?.dependencies['lodash']).toBe('4.17.21')
  })

  it('gives a later-processed package its own satisfying version even after an incompatible one won the dedup slot', async () => {
    // pkg-a resolves first and needs lodash@^4 (wins the shared "lodash" slot).
    // pkg-b resolves after and needs the older lodash@^3 — it must not be wired
    // to pkg-a's ^4 winner just because that's what "lodash" globally resolved to.
    const CONFLICT_REGISTRY = {
      ...REGISTRY,
      'pkg-a': makePackument('pkg-a', { '1.0.0': { deps: { lodash: '^4.0.0' } } }),
      'pkg-b': makePackument('pkg-b', { '1.0.0': { deps: { lodash: '^3.0.0' } } }),
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

    expect(tree.packages.get('pkg-a@1.0.0')?.dependencies['lodash']).toBe('4.17.21')
    expect(tree.packages.get('pkg-b@1.0.0')?.dependencies['lodash']).toBe('3.10.1')
  })
})

describe('Resolver.resolveFromLock — reads package.json alongside the lockfile', () => {
  it('populates directDeps from dependencies, devDependencies, and optionalDependencies', async () => {
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
    await writePackageJson(tmpDir, {
      dependencies: { express: '^4.0.0' },
      devDependencies: { jest: '29.0.0' },
      optionalDependencies: { 'some-optional': '^1.0.0' },
    })

    const resolver = new Resolver()
    const tree = await resolver.resolveFromLock(lockPath)

    expect(tree.directDeps).toContainEqual({ name: 'express', range: '^4.0.0', type: 'prod' })
    expect(tree.directDeps).toContainEqual({ name: 'jest', range: '29.0.0', type: 'dev' })
    expect(tree.directDeps).toContainEqual({ name: 'some-optional', range: '^1.0.0', type: 'optional' })
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

  it('always returns an empty riskFindings array — no registry access means nothing to risk-check', async () => {
    const lockfile = {
      lockfileVersion: 1,
      sandboxpmVersion: '0.1.0',
      packages: {
        'lodahs@1.0.0': { // even a typosquat-looking name in the lockfile isn't flagged
          resolved: 'https://registry.npmjs.org/lodahs/-/lodahs-1.0.0.tgz',
          integrity: 'sha512-abc==',
          dependencies: {},
        },
      },
    }
    const lockPath = path.join(tmpDir, 'sandboxpm.lock')
    await fs.writeFile(lockPath, JSON.stringify(lockfile))

    const resolver = new Resolver()
    const tree = await resolver.resolveFromLock(lockPath)

    expect(tree.riskFindings).toEqual([])
  })
})

describe('Resolver.resolve — package risk findings', () => {
  it('flags a typosquat-adjacent transitive dependency in riskFindings', async () => {
    const RISK_REGISTRY = {
      ...REGISTRY,
      lodahs: makePackument('lodahs', { '1.0.0': { deps: {} } }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = RISK_REGISTRY[name as keyof typeof RISK_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, { dependencies: { lodahs: '^1.0.0' } })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    expect(tree.riskFindings).toHaveLength(1)
    expect(tree.riskFindings[0]?.name).toBe('lodahs')
    expect(tree.riskFindings[0]?.reasons[0]).toContain('typosquat:lodash')
  })

  it('does not flag a trusted package even if it matches a typosquat pattern', async () => {
    const RISK_REGISTRY = {
      ...REGISTRY,
      lodahs: makePackument('lodahs', { '1.0.0': { deps: {} } }),
    }
    vi.spyOn(global, 'fetch' as keyof typeof global).mockImplementation(async (url) => {
      const name = String(url).replace('https://registry.npmjs.org/', '')
      const packument = RISK_REGISTRY[name as keyof typeof RISK_REGISTRY]
      if (!packument) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => packument } as Response
    })

    await writePackageJson(tmpDir, { dependencies: { lodahs: '^1.0.0' } })

    const resolver = new Resolver([], { trustedPackages: ['lodahs'] })
    const tree = await resolver.resolve(tmpDir)

    expect(tree.riskFindings).toEqual([])
  })

  it('does not flag ordinary, well-known dependencies', async () => {
    mockRegistry()
    await writePackageJson(tmpDir, { dependencies: { express: '^4.0.0' } })

    const resolver = new Resolver()
    const tree = await resolver.resolve(tmpDir)

    expect(tree.riskFindings).toEqual([])
  })
})

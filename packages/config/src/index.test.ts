import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Node 24 ESM namespace properties are non-configurable; spread into a plain
// object so vi.spyOn can replace individual methods (used for global-config tests).
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return { ...actual }
})

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { loadRc, saveRc, defaultRc, mergeRc, loadGlobalConfig, saveGlobalConfig, getHostPlatform, matchesHostPlatform } from './index.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-config-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('defaultRc', () => {
  it('returns safe defaults', () => {
    const rc = defaultRc()
    expect(rc.version).toBe(1)
    expect(rc.sandbox.memory).toBe('1g')
    expect(rc.sandbox.networkMode).toBe('isolated')
    expect(rc.sandbox.auditSyscalls).toBe(false)
    expect(rc.cache.enabled).toBe(true)
    expect(rc.whitelist).toEqual([])
    expect(rc.blacklist).toEqual([])
  })
})

describe('mergeRc', () => {
  it('deep-merges sandbox overrides', () => {
    const base = defaultRc()
    const result = mergeRc(base, { sandbox: { memory: '2g', cpus: 2.0, timeout: 60, networkMode: 'none', auditSyscalls: false } })
    expect(result.sandbox.memory).toBe('2g')
    expect(result.sandbox.cpus).toBe(2.0)
    // other fields from base are preserved
    expect(result.cache.enabled).toBe(true)
  })

  it('merges cache overrides', () => {
    const base = defaultRc()
    const result = mergeRc(base, { cache: { enabled: false, maxSizeGb: 5, ttlDays: 7 } })
    expect(result.cache.enabled).toBe(false)
    expect(result.cache.maxSizeGb).toBe(5)
  })

  it('overrides registries array entirely', () => {
    const base = defaultRc()
    const custom = [{ url: 'https://custom.registry.io' }]
    const result = mergeRc(base, { registries: custom })
    expect(result.registries).toEqual(custom)
  })
})

describe('loadRc', () => {
  it('returns defaults when no .sandboxpmrc exists', async () => {
    const rc = await loadRc(tmpDir)
    expect(rc).toEqual(defaultRc())
  })

  it('loads and merges a .sandboxpmrc file', async () => {
    const rcContent = `
version: 1
sandbox:
  memory: "512m"
  networkMode: "none"
`
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), rcContent)
    const rc = await loadRc(tmpDir)
    expect(rc.sandbox.memory).toBe('512m')
    expect(rc.sandbox.networkMode).toBe('none')
    expect(rc.cache.enabled).toBe(true) // default preserved
  })

  it('walks up to parent directories', async () => {
    const subDir = path.join(tmpDir, 'a', 'b', 'c')
    await fs.mkdir(subDir, { recursive: true })

    const rcContent = `version: 1\nwhitelist:\n  - "some-package"\n`
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), rcContent)

    const rc = await loadRc(subDir)
    expect(rc.whitelist).toContain('some-package')
  })

  it('throws on invalid networkMode', async () => {
    const rcContent = `sandbox:\n  networkMode: "invalid"\n`
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), rcContent)
    await expect(loadRc(tmpDir)).rejects.toThrow(/networkMode/)
  })

  it('throws when the parsed YAML is not an object', async () => {
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), 'just a plain string\n')
    await expect(loadRc(tmpDir)).rejects.toThrow(/must be a YAML object/)
  })

  it('throws when "version" is present but not a number', async () => {
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), 'version: "one"\n')
    await expect(loadRc(tmpDir)).rejects.toThrow(/"version" must be a number/)
  })

  it('throws when "sandbox" is present but not an object', async () => {
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), 'sandbox: "oops"\n')
    await expect(loadRc(tmpDir)).rejects.toThrow(/"sandbox" must be an object/)
  })

  it('throws when "policies" is present but not an object', async () => {
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), 'policies: "oops"\n')
    await expect(loadRc(tmpDir)).rejects.toThrow(/"policies" must be an object/)
  })

  it('throws on invalid policies.onWarn', async () => {
    const rcContent = `policies:\n  onWarn: "nope"\n`
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), rcContent)
    await expect(loadRc(tmpDir)).rejects.toThrow(/onWarn/)
  })

  it('throws on invalid policies.onBlock', async () => {
    const rcContent = `policies:\n  onBlock: "nope"\n`
    await fs.writeFile(path.join(tmpDir, '.sandboxpmrc'), rcContent)
    await expect(loadRc(tmpDir)).rejects.toThrow(/onBlock/)
  })
})

describe('saveRc / loadRc round-trip', () => {
  it('saves and reloads identical config', async () => {
    const rc = mergeRc(defaultRc(), {
      whitelist: ['trusted-pkg'],
      sandbox: { memory: '2g', cpus: 2, timeout: 60, networkMode: 'restricted', auditSyscalls: false },
    })
    await saveRc(tmpDir, rc)
    const loaded = await loadRc(tmpDir)
    expect(loaded.whitelist).toEqual(['trusted-pkg'])
    expect(loaded.sandbox.memory).toBe('2g')
    expect(loaded.sandbox.networkMode).toBe('restricted')
  })
})

describe('loadGlobalConfig', () => {
  it('returns defaults when no global config exists', async () => {
    const config = await loadGlobalConfig()
    expect(config.storeDir).toContain('.sandboxpm')
    expect(config.cacheDir).toContain('.sandboxpm')
  })

  it('merges an existing global config file onto the defaults', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(
      JSON.stringify({ storeDir: '/custom/store' })
    )
    const config = await loadGlobalConfig()
    expect(config.storeDir).toBe('/custom/store')
    // untouched fields still come from the defaults
    expect(config.cacheDir).toContain('.sandboxpm')
    expect(config.reportsDir).toContain('.sandboxpm')
  })

  it('rethrows a non-ENOENT error while reading the global config', async () => {
    const err = Object.assign(new Error('boom'), { code: 'EACCES' })
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(err)
    await expect(loadGlobalConfig()).rejects.toThrow('boom')
  })
})

describe('saveGlobalConfig', () => {
  it('writes via a temp file and renames it into place', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValueOnce(undefined)
    const writeSpy = vi.spyOn(fs, 'writeFile').mockResolvedValueOnce(undefined)
    const renameSpy = vi.spyOn(fs, 'rename').mockResolvedValueOnce(undefined)

    const config = { storeDir: 'a', cacheDir: 'b', reportsDir: 'c' }
    await saveGlobalConfig(config)

    expect(mkdirSpy).toHaveBeenCalledWith(expect.stringContaining('.sandboxpm'), { recursive: true })
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('config.json.tmp'),
      JSON.stringify(config, null, 2),
      'utf8',
    )
    expect(renameSpy).toHaveBeenCalledWith(
      expect.stringContaining('config.json.tmp'),
      expect.stringContaining('config.json'),
    )
  })
})

describe('getHostPlatform', () => {
  it('returns the real host platform and caches it across calls', () => {
    const first = getHostPlatform()
    expect(first.os).toBe(process.platform)
    expect(first.cpu).toBe(process.arch)

    // second call hits the cache branch and returns the same object
    const second = getHostPlatform()
    expect(second).toBe(first)
  })

  it('detects libc when the host platform is linux', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const fresh = await import('./index.js')
      const host = fresh.getHostPlatform()
      expect(host.os).toBe('linux')
      expect(['glibc', 'musl']).toContain(host.libc)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

describe('matchesHostPlatform', () => {
  it('matches when the positive os list includes the host', () => {
    expect(matchesHostPlatform({ os: ['win32', 'linux'] }, { os: 'win32', cpu: 'x64' })).toBe(true)
    expect(matchesHostPlatform({ os: ['linux'] }, { os: 'win32', cpu: 'x64' })).toBe(false)
  })

  it('respects "!value" negation', () => {
    expect(matchesHostPlatform({ os: ['!win32'] }, { os: 'linux', cpu: 'x64' })).toBe(true)
    expect(matchesHostPlatform({ os: ['!win32'] }, { os: 'win32', cpu: 'x64' })).toBe(false)
  })

  it('rejects a libc constraint on a non-linux host', () => {
    expect(matchesHostPlatform({ os: ['darwin'], libc: ['musl'] }, { os: 'darwin', cpu: 'arm64' })).toBe(false)
  })

  it('matches libc on linux, defaulting the host to glibc when undetected', () => {
    expect(matchesHostPlatform({ os: ['linux'], libc: ['glibc'] }, { os: 'linux', cpu: 'x64' })).toBe(true)
    expect(matchesHostPlatform({ os: ['linux'], libc: ['musl'] }, { os: 'linux', cpu: 'x64', libc: 'glibc' })).toBe(false)
  })

  it('treats absent or empty constraint lists as matching everything', () => {
    expect(matchesHostPlatform({}, { os: 'win32', cpu: 'arm64' })).toBe(true)
    expect(matchesHostPlatform({ os: [] }, { os: 'win32', cpu: 'arm64' })).toBe(true)
  })
})

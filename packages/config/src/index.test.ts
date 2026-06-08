import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { loadRc, saveRc, defaultRc, mergeRc, loadGlobalConfig } from './index.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-config-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('defaultRc', () => {
  it('returns safe defaults', () => {
    const rc = defaultRc()
    expect(rc.version).toBe(1)
    expect(rc.sandbox.memory).toBe('1g')
    expect(rc.sandbox.networkMode).toBe('isolated')
    expect(rc.cache.enabled).toBe(true)
    expect(rc.whitelist).toEqual([])
    expect(rc.blacklist).toEqual([])
  })
})

describe('mergeRc', () => {
  it('deep-merges sandbox overrides', () => {
    const base = defaultRc()
    const result = mergeRc(base, { sandbox: { memory: '2g', cpus: 2.0, timeout: 60, networkMode: 'none' } })
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
})

describe('saveRc / loadRc round-trip', () => {
  it('saves and reloads identical config', async () => {
    const rc = mergeRc(defaultRc(), {
      whitelist: ['trusted-pkg'],
      sandbox: { memory: '2g', cpus: 2, timeout: 60, networkMode: 'restricted' },
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
})

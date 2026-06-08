/**
 * @sandboxpm/resolver
 *
 * Resolves a package.json dependency tree into exact versions,
 * deduplicates using pnpm-style nested resolution, and writes sandboxpm.lock.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import * as semver from 'semver'
import type { RegistryConfig } from '@sandboxpm/config'

export interface DependencyRange {
  name: string
  range: string
  type: 'prod' | 'dev' | 'optional' | 'peer'
}

export interface ResolvedPackage {
  name: string
  version: string
  resolved: string
  integrity: string
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
  cpu?: string[]
  os?: string[]
}

export interface ResolvedTree {
  root: string
  packages: Map<string, ResolvedPackage>  // key: "name@version"
  directDeps: DependencyRange[]
  lockfileHash: string
}

export interface Lockfile {
  lockfileVersion: number
  sandboxpmVersion: string
  packages: Record<string, LockfileEntry>
}

export interface LockfileEntry {
  resolved: string
  integrity: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  hasBin?: boolean
  scripts?: Record<string, string>
}

// Minimal npm registry packument shape
interface PackumentVersion {
  name: string
  version: string
  dist: { tarball: string; integrity?: string; shasum?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  scripts?: Record<string, string>
  bin?: string | Record<string, string>
  cpu?: string[]
  os?: string[]
}

interface Packument {
  name: string
  versions: Record<string, PackumentVersion>
  'dist-tags': Record<string, string>
}

export interface ResolverOptions {
  includeDev?: boolean
}

const LOCKFILE_NAME = 'sandboxpm.lock'
const SANDBOXPM_VERSION = '0.1.0'

export class Resolver {
  private readonly registries: RegistryConfig[]
  private readonly options: ResolverOptions
  private readonly packumentCache = new Map<string, Packument>()

  constructor(registries: RegistryConfig[] = [], options: ResolverOptions = {}) {
    this.registries = registries.length > 0
      ? registries
      : [{ url: 'https://registry.npmjs.org' }]
    this.options = options
  }

  private get registryUrl(): string {
    const reg = this.registries[0]
    return reg ? reg.url.replace(/\/$/, '') : 'https://registry.npmjs.org'
  }

  async fetchPackument(name: string): Promise<Packument> {
    const cached = this.packumentCache.get(name)
    if (cached) return cached

    let lastErr: Error | undefined
    for (const registry of this.registries) {
      try {
        const baseUrl = registry.url.replace(/\/$/, '')
        const url = `${baseUrl}/${encodeURIComponent(name)}`
        const headers: Record<string, string> = registry.token
          ? { Authorization: `Bearer ${registry.token}` }
          : {}
        const res = await fetch(url, { headers })
        if (!res.ok) {
          lastErr = new Error(`Registry ${baseUrl}: ${res.status} ${res.statusText}`)
          continue
        }
        const packument = await res.json() as Packument
        this.packumentCache.set(name, packument)
        return packument
      } catch (err) {
        lastErr = err as Error
      }
    }
    throw lastErr ?? new Error(`Package "${name}" not found in any configured registry`)
  }

  selectVersion(packument: Packument, range: string): string | null {
    const versions = Object.keys(packument.versions)
    // Handle dist-tags like "latest", "next"
    const distTag = packument['dist-tags'][range]
    if (distTag && packument.versions[distTag]) return distTag

    return semver.maxSatisfying(versions, range)
  }

  async resolve(projectDir: string): Promise<ResolvedTree> {
    const pkgJsonPath = path.join(projectDir, 'package.json')
    const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }

    const directDeps: DependencyRange[] = []
    for (const [name, range] of Object.entries(pkgJson.dependencies ?? {})) {
      directDeps.push({ name, range, type: 'prod' })
    }
    if (this.options.includeDev !== false) {
      for (const [name, range] of Object.entries(pkgJson.devDependencies ?? {})) {
        directDeps.push({ name, range, type: 'dev' })
      }
    }
    for (const [name, range] of Object.entries(pkgJson.optionalDependencies ?? {})) {
      directDeps.push({ name, range, type: 'optional' })
    }

    // BFS resolution with dedup
    const resolved = new Map<string, ResolvedPackage>() // "name@version" → package
    // resolvedVersions maps name → version for dedup (first/highest wins per range group)
    const resolvedVersions = new Map<string, string>() // name → exact version

    type QueueItem = { name: string; range: string; isPeer?: boolean }
    const queue: QueueItem[] = directDeps.map(d => ({ name: d.name, range: d.range }))
    const visiting = new Set<string>() // prevent infinite loops

    while (queue.length > 0) {
      const item = queue.shift()
      if (item === undefined) break
      const { name, range } = item

      // Check if we already have a resolved version that satisfies this range
      const existing = resolvedVersions.get(name)
      if (existing && semver.satisfies(existing, range)) {
        continue  // dedup — reuse the existing version
      }

      let packument: Packument
      try {
        packument = await this.fetchPackument(name)
      } catch (err) {
        if (item.isPeer) {
          console.warn(`[sandboxpm] peer dep warning: failed to fetch "${name}" — ${(err as Error).message}`)
          continue
        }
        throw err
      }

      const version = this.selectVersion(packument, range)
      if (!version) {
        if (item.isPeer) {
          console.warn(`[sandboxpm] peer dep warning: no version of "${name}" satisfies "${range}" — skipping`)
          continue
        }
        throw new Error(`No version of "${name}" satisfies range "${range}"`)
      }

      const key = `${name}@${version}`
      if (visiting.has(key)) continue
      visiting.add(key)

      if (resolved.has(key)) continue  // already resolved this exact version

      const pv = packument.versions[version]
      if (!pv) throw new Error(`Version "${version}" not found in packument for "${name}"`)

      const depVersions: Record<string, string> = {}
      for (const [depName, depRange] of Object.entries(pv.dependencies ?? {})) {
        queue.push({ name: depName, range: depRange })
        depVersions[depName] = depRange
      }

      // Enqueue peer deps only if not already resolved; unsatisfiable peers warn, never throw
      for (const [depName, depRange] of Object.entries(pv.peerDependencies ?? {})) {
        if (!resolvedVersions.has(depName)) {
          queue.push({ name: depName, range: depRange, isPeer: true })
        }
      }

      const integrity = pv.dist.integrity ?? (pv.dist.shasum ? `sha1-${pv.dist.shasum}` : '')

      const pkg: ResolvedPackage = {
        name,
        version,
        resolved: pv.dist.tarball,
        integrity,
        dependencies: depVersions,
      }
      if (pv.scripts) pkg.scripts = pv.scripts
      if (pv.cpu) pkg.cpu = pv.cpu
      if (pv.os) pkg.os = pv.os
      resolved.set(key, pkg)

      // Record this version for future dedup (if no existing or existing doesn't satisfy)
      if (!existing) {
        resolvedVersions.set(name, version)
      }
    }

    // Second pass: resolve dep version ranges to exact versions
    for (const pkg of resolved.values()) {
      const exactDeps: Record<string, string> = {}
      for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
        const exact = resolvedVersions.get(depName)
        exactDeps[depName] = exact ?? depRange
      }
      pkg.dependencies = exactDeps
    }

    const lockfileHash = await this._writeLockfile(projectDir, resolved)

    return {
      root: projectDir,
      packages: resolved,
      directDeps,
      lockfileHash,
    }
  }

  async resolveFromLock(lockfilePath: string): Promise<ResolvedTree> {
    const content = await fs.readFile(lockfilePath, 'utf8')
    const lockfile = JSON.parse(content) as Lockfile

    const packages = new Map<string, ResolvedPackage>()
    for (const [key, entry] of Object.entries(lockfile.packages)) {
      const atIdx = key.lastIndexOf('@')
      if (atIdx < 1) throw new Error(`Invalid lockfile key: ${key}`)
      const name = key.slice(0, atIdx)
      const version = key.slice(atIdx + 1)
      const pkg: ResolvedPackage = {
        name,
        version,
        resolved: entry.resolved,
        integrity: entry.integrity,
        dependencies: entry.dependencies ?? {},
      }
      if (entry.scripts) pkg.scripts = entry.scripts
      packages.set(key, pkg)
    }

    return {
      root: path.dirname(lockfilePath),
      packages,
      directDeps: [],
      lockfileHash: crypto.createHash('sha256').update(content).digest('hex'),
    }
  }

  private async _writeLockfile(
    projectDir: string,
    resolved: Map<string, ResolvedPackage>,
  ): Promise<string> {
    const packages: Record<string, LockfileEntry> = {}

    // Sort keys deterministically
    const sortedKeys = [...resolved.keys()].sort()
    for (const key of sortedKeys) {
      const pkg = resolved.get(key)
      if (pkg === undefined) continue
      const entry: LockfileEntry = {
        resolved: pkg.resolved,
        integrity: pkg.integrity,
      }
      if (Object.keys(pkg.dependencies).length > 0) {
        entry.dependencies = sortObjectKeys(pkg.dependencies)
      }
      if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
        entry.scripts = pkg.scripts
      }
      packages[key] = entry
    }

    const lockfile: Lockfile = {
      lockfileVersion: 1,
      sandboxpmVersion: SANDBOXPM_VERSION,
      packages,
    }

    const content = JSON.stringify(lockfile, null, 2) + '\n'
    const lockfilePath = path.join(projectDir, LOCKFILE_NAME)
    const tmp = `${lockfilePath}.tmp.${crypto.randomBytes(4).toString('hex')}`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, lockfilePath)

    return crypto.createHash('sha256').update(content).digest('hex')
  }
}

function sortObjectKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
}

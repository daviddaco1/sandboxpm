/**
 * @sandboxpm/fetcher
 *
 * Downloads package tarballs from the npm registry, verifies SHA-512 integrity,
 * extracts them, and populates the CAS store.
 *
 * NEVER executes any scripts — only reads file content.
 */

import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import { createWriteStream } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventEmitter } from 'events'
import * as tar from 'tar'
import pLimit from 'p-limit'

import type { CASStore } from '@sandboxpm/store'
import { hashFile } from '@sandboxpm/store'
import type { RegistryConfig } from '@sandboxpm/config'
import { getHostPlatform, matchesHostPlatform } from '@sandboxpm/config'

export interface PackageId {
  name: string
  version: string       // exact resolved version e.g. "4.18.2"
  os?: string[]          // optionalDependencies platform constraint, e.g. ["win32"]
  cpu?: string[]
  libc?: string[]
}

export interface PackageScript {
  lifecycle: 'preinstall' | 'install' | 'postinstall'
  command: string
  inspectUrl: string
}

export interface FileMapping {
  hash: string          // sha512 hex — key into CAS store
  relativePath: string  // path within package dir, e.g. "lib/index.js"
  mode: number          // file permission bits
  size: number
}

export interface FetchResult {
  packageId: PackageId
  files: FileMapping[]
  scripts: PackageScript[]
  fromCache: boolean    // true if all files were already in store
}

export interface FetcherOptions {
  concurrency?: number  // default 8
  tmpDir?: string
}

// Minimal shape of the npm registry packument version entry
interface PackumentVersion {
  name: string
  version: string
  dist: {
    tarball: string
    integrity?: string   // "sha512-<base64>"
    shasum?: string      // sha1 hex fallback
  }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  bin?: string | Record<string, string>
}

const INSTALL_SCRIPTS: Array<PackageScript['lifecycle']> = [
  'preinstall', 'install', 'postinstall',
]

export function buildInspectUrl(name: string, version: string, scriptCommand: string): string {
  // Try to extract the JS file the script runs
  // Patterns: "node install.js", "node scripts/post.mjs", "node-pre-gyp install", etc.
  const nodeFileMatch = scriptCommand.match(/^node\s+([\w./\-]+\.[mc]?js)/i)
  if (nodeFileMatch) {
    const file = nodeFileMatch[1]
    if (file !== undefined) {
      return `https://unpkg.com/${name}@${version}/${file}`
    }
  }
  return `https://www.npmjs.com/package/${name}?activeTab=code`
}

export class Fetcher extends EventEmitter {
  private readonly store: CASStore
  private readonly registries: RegistryConfig[]
  private readonly concurrency: number
  private readonly tmpBase: string

  constructor(store: CASStore, registries: RegistryConfig[], options: FetcherOptions = {}) {
    super()
    this.store = store
    this.registries = registries.length > 0 ? registries : [{ url: 'https://registry.npmjs.org' }]
    this.concurrency = options.concurrency ?? 8
    this.tmpBase = options.tmpDir ?? os.tmpdir()
  }

  async *fetch(packages: PackageId[]): AsyncIterable<FetchResult> {
    // A multi-platform lockfile (see resolver) records every platform variant of an
    // optional dependency; only the current host's actually gets downloaded. Filtering
    // before fetchOne() means a mismatched sibling never even triggers an HTTP request
    // — this must stay silent, since most entries in a multi-platform lock won't match
    // any given host.
    const host = getHostPlatform()
    const matching = packages.filter(pkg => matchesHostPlatform(pkg, host))

    const limit = pLimit(this.concurrency)
    const results: Array<Promise<FetchResult>> = matching.map(pkg =>
      limit(() => this.fetchOne(pkg))
    )

    for (const promise of results) {
      const result = await promise
      this.emit('progress', result)
      yield result
    }
  }

  async fetchOne(pkg: PackageId): Promise<FetchResult> {
    const pv = await this.fetchPackumentVersion(pkg)
    return this._fetchFromPackumentVersion(pkg, pv)
  }

  private get registryUrl(): string {
    const reg = this.registries[0]
    return reg ? reg.url.replace(/\/$/, '') : 'https://registry.npmjs.org'
  }

  private authHeader(): Record<string, string> {
    const reg = this.registries[0]
    if (reg?.token) return { Authorization: `Bearer ${reg.token}` }
    return {}
  }

  private async fetchPackumentVersion(pkg: PackageId): Promise<PackumentVersion> {
    const url = `${this.registryUrl}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`
    const res = await fetch(url, { headers: this.authHeader() })
    if (!res.ok) {
      throw new Error(`Registry fetch failed for ${pkg.name}@${pkg.version}: ${res.status} ${res.statusText}`)
    }
    return res.json() as Promise<PackumentVersion>
  }

  private _manifestPath(integrity: string): string {
    // Replace characters that are unsafe in filenames
    const key = integrity.replace(/[^a-zA-Z0-9-]/g, '_')
    return path.join(this.store.storeDir, 'meta', `${key}.json`)
  }

  private async _fetchFromPackumentVersion(pkg: PackageId, pv: PackumentVersion): Promise<FetchResult> {
    const tarballUrl = pv.dist.tarball
    const expectedIntegrity = pv.dist.integrity // "sha512-<base64>"

    // 1. Check manifest cache — skip download if all files are already in the store
    if (expectedIntegrity) {
      const mPath = this._manifestPath(expectedIntegrity)
      try {
        const cached = JSON.parse(await fs.readFile(mPath, 'utf8')) as {
          files: FileMapping[]
          scripts: PackageScript[]
        }
        const allPresent = await Promise.all(cached.files.map(f => this.store.has(f.hash)))
        if (allPresent.every(Boolean)) {
          // Filter against current INSTALL_SCRIPTS so removing a lifecycle
          // (e.g. 'prepare') takes effect without requiring a cache clear.
          const scripts = cached.scripts.filter(
            s => (INSTALL_SCRIPTS as readonly string[]).includes(s.lifecycle)
          )
          return { packageId: pkg, files: cached.files, scripts, fromCache: true }
        }
      } catch {
        // Manifest missing or malformed → proceed with download
      }
    }

    // 2. Download and extract
    const tmpFile = path.join(this.tmpBase, `sandboxpm-${pkg.name.replace(/\//g, '-')}-${pkg.version}-${crypto.randomBytes(8).toString('hex')}.tgz`)
    const computedHash = await this._downloadAndVerify(tarballUrl, tmpFile, expectedIntegrity, pkg)

    const extractDir = `${tmpFile}.extracted`
    await fs.mkdir(extractDir, { recursive: true })

    try {
      await tar.extract({ file: tmpFile, cwd: extractDir, strip: 1 })

      const files = await this._collectFiles(extractDir, computedHash, pkg)
      const scripts = this._extractScripts(pv)

      // 3. Save manifest so next install can skip the download
      if (expectedIntegrity) {
        try {
          const mPath = this._manifestPath(expectedIntegrity)
          await fs.mkdir(path.dirname(mPath), { recursive: true })
          await fs.writeFile(mPath, JSON.stringify({ files, scripts }))
        } catch {
          // Non-fatal — manifest write failure just means next install re-downloads
        }
      }

      return { packageId: pkg, files, scripts, fromCache: false }
    } finally {
      await fs.rm(tmpFile, { force: true })
      await fs.rm(extractDir, { recursive: true, force: true })
    }
  }

  private async _downloadAndVerify(
    url: string,
    destPath: string,
    expectedIntegrity: string | undefined,
    pkg: PackageId,
  ): Promise<string> {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to download tarball for ${pkg.name}@${pkg.version}: ${res.status}`)
    }
    if (!res.body) {
      throw new Error(`Empty response body for ${pkg.name}@${pkg.version}`)
    }
    const body = res.body

    const hash = crypto.createHash('sha512')
    const writer = createWriteStream(destPath)

    await new Promise<void>((resolve, reject) => {
      const reader = body.getReader()

      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) {
            writer.end()
            return
          }
          const chunk = Buffer.from(value)
          hash.update(chunk)
          if (!writer.write(chunk)) {
            writer.once('drain', pump)
          } else {
            pump()
          }
        }).catch(reject)
      }

      writer.on('finish', resolve)
      writer.on('error', reject)
      pump()
    })

    const computedHex = hash.digest('hex')

    if (expectedIntegrity) {
      // Format: "sha512-<base64>"
      const prefix = 'sha512-'
      if (expectedIntegrity.startsWith(prefix)) {
        const expectedHex = Buffer.from(
          expectedIntegrity.slice(prefix.length), 'base64'
        ).toString('hex')
        if (computedHex !== expectedHex) {
          await fs.rm(destPath, { force: true })
          throw new Error(
            `Integrity mismatch for ${pkg.name}@${pkg.version}: ` +
            `expected ${expectedHex}, got ${computedHex}`
          )
        }
      }
    }

    return computedHex
  }

  private async _collectFiles(
    dir: string,
    _tarballHash: string,
    pkg: PackageId,
  ): Promise<FileMapping[]> {
    const files: FileMapping[] = []
    await this._walkDir(dir, dir, files, pkg)
    return files
  }

  private async _walkDir(
    baseDir: string,
    currentDir: string,
    files: FileMapping[],
    pkg: PackageId,
  ): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await this._walkDir(baseDir, fullPath, files, pkg)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink()) continue  // skip symlinks in tarballs
        const stat = await fs.stat(fullPath)
        const hash = await hashFile(fullPath)
        await this.store.put(hash, fullPath)

        const relativePath = path.relative(baseDir, fullPath)
        files.push({
          hash,
          relativePath,
          mode: stat.mode,
          size: stat.size,
        })
      }
    }
  }

  private _extractScripts(pv: PackumentVersion): PackageScript[] {
    const pkgScripts = pv.scripts ?? {}
    const result: PackageScript[] = []

    for (const lifecycle of INSTALL_SCRIPTS) {
      const command = pkgScripts[lifecycle]
      if (command) {
        result.push({
          lifecycle,
          command,
          inspectUrl: buildInspectUrl(pv.name, pv.version, command),
        })
      }
    }
    return result
  }
}

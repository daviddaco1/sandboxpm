/**
 * @sandboxpm/store
 *
 * Content-Addressable Store (CAS) — the heart of sandboxpm.
 *
 * Each file is stored once at ~/.sandboxpm/store/{sha512-hex}.
 * node_modules files are hard links into the store — never copies.
 */

import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import { createReadStream } from 'fs'
import * as path from 'path'

function randomSuffix(): string {
  return crypto.randomBytes(8).toString('hex')
}

export interface StoreEntry {
  hash: string          // sha512 hex
  size: number          // bytes
  addedAt: number       // unix timestamp
}

export interface StoreStats {
  totalFiles: number
  totalSizeBytes: number
  storeDir: string
}

export class CASStore {
  readonly storeDir: string

  constructor(storeDir: string) {
    this.storeDir = storeDir
  }

  private storePath(hash: string): string {
    return path.join(this.storeDir, hash)
  }

  async has(hash: string): Promise<boolean> {
    try {
      await fs.access(this.storePath(hash))
      return true
    } catch {
      return false
    }
  }

  /**
   * Copy a file into the store under its hash. Atomic: write to temp, then rename.
   * No-op if the file is already present.
   */
  async put(hash: string, sourcePath: string): Promise<void> {
    const dest = this.storePath(hash)
    if (await this.has(hash)) return

    await fs.mkdir(this.storeDir, { recursive: true })

    const tmp = `${dest}.tmp.${randomSuffix()}`
    try {
      await fs.copyFile(sourcePath, tmp)
      // Another concurrent put may have won the race — that's fine
      try {
        await fs.rename(tmp, dest)
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code === 'ENOENT' && await this.has(hash)) {
          // Lost the race; the winner already renamed. Clean up our temp file.
          await fs.rm(tmp, { force: true })
          return
        }
        throw renameErr
      }
    } catch (err) {
      // Clean up partial temp file on failure
      await fs.rm(tmp, { force: true })
      throw err
    }
  }

  /**
   * Hard-link a store entry to destPath.
   * Falls back to copyFile on EXDEV (cross-device / different filesystem).
   */
  async link(hash: string, destPath: string): Promise<void> {
    const src = this.storePath(hash)
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    try {
      await fs.link(src, destPath)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'EEXIST') return  // already linked, fine
      if (e.code === 'EXDEV') {
        await fs.copyFile(src, destPath)
        return
      }
      throw err
    }
  }

  /** Recompute SHA-512 of the stored file and compare to hash. */
  async verify(hash: string): Promise<boolean> {
    try {
      const computed = await hashFile(this.storePath(hash))
      return computed === hash
    } catch {
      return false
    }
  }

  async stat(hash: string): Promise<StoreEntry> {
    const st = await fs.stat(this.storePath(hash))
    return {
      hash,
      size: st.size,
      addedAt: Math.floor(st.mtimeMs),
    }
  }

  /** Remove store entries not referenced by the given set. Returns bytes freed. */
  async gc(referencedHashes: Set<string>): Promise<number> {
    let freed = 0
    let entries: string[]
    try {
      entries = await fs.readdir(this.storeDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }

    for (const entry of entries) {
      if (!referencedHashes.has(entry)) {
        const p = path.join(this.storeDir, entry)
        try {
          const st = await fs.stat(p)
          await fs.rm(p, { force: true })
          freed += st.size
        } catch {
          // If the file disappeared between readdir and stat, ignore
        }
      }
    }
    return freed
  }

  /** Remove store entries whose mtime is older than ttlDays. Returns bytes freed. */
  async gcByTtl(ttlDays: number): Promise<number> {
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000
    let freed = 0
    let entries: { name: string; isFile(): boolean }[]
    try {
      entries = await fs.readdir(this.storeDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = path.join(this.storeDir, entry.name)
      try {
        const stat = await fs.stat(filePath)
        if (stat.mtimeMs < cutoff) {
          freed += stat.size
          await fs.rm(filePath, { force: true })
        }
      } catch {
        // file may have been removed between readdir and stat
      }
    }
    return freed
  }

  async stats(): Promise<StoreStats> {
    let totalFiles = 0
    let totalSizeBytes = 0

    let entries: string[]
    try {
      entries = await fs.readdir(this.storeDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { totalFiles: 0, totalSizeBytes: 0, storeDir: this.storeDir }
      }
      throw err
    }

    for (const entry of entries) {
      try {
        const st = await fs.stat(path.join(this.storeDir, entry))
        if (st.isFile()) {
          totalFiles++
          totalSizeBytes += st.size
        }
      } catch {
        // skip files that disappear mid-iteration
      }
    }

    return { totalFiles, totalSizeBytes, storeDir: this.storeDir }
  }
}

/** Compute the SHA-512 hex digest of a file. */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk as Buffer))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** Compute the SHA-512 hex digest of a Buffer. */
export function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha512').update(buf).digest('hex')
}

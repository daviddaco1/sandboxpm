import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Node 24 ESM namespace properties are non-configurable; spread into a plain
// object so vi.spyOn can replace individual methods (used in the EXDEV test).
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return { ...actual }
})

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { CASStore, hashFile, hashBuffer } from './index.js'

let tmpDir: string
let storeDir: string
let store: CASStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-store-test-'))
  storeDir = path.join(tmpDir, 'store')
  store = new CASStore(storeDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name)
  await fs.writeFile(p, content)
  return p
}

describe('hashFile / hashBuffer', () => {
  it('produces consistent sha512 hashes', async () => {
    const filePath = await writeFile('hello.txt', 'hello world')
    const fromFile = await hashFile(filePath)
    const fromBuf = hashBuffer(Buffer.from('hello world'))
    expect(fromFile).toBe(fromBuf)
    expect(fromFile).toHaveLength(128) // hex sha512 = 64 bytes = 128 hex chars
  })
})

describe('CASStore.put + has', () => {
  it('stores a file and reports has=true', async () => {
    const filePath = await writeFile('pkg.txt', 'package content')
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)
    expect(await store.has(hash)).toBe(true)
  })

  it('is idempotent — second put does not throw', async () => {
    const filePath = await writeFile('dup.txt', 'data')
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)
    await store.put(hash, filePath) // should be no-op
    expect(await store.has(hash)).toBe(true)
  })

  it('reports has=false for unknown hash', async () => {
    expect(await store.has('a'.repeat(128))).toBe(false)
  })
})

describe('CASStore.link', () => {
  it('hard-links a store entry to a destination', async () => {
    const content = 'hello from store'
    const filePath = await writeFile('src.txt', content)
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)

    const dest = path.join(tmpDir, 'linked', 'file.txt')
    await store.link(hash, dest)

    const read = await fs.readFile(dest, 'utf8')
    expect(read).toBe(content)

    // Verify they share the same inode (hard link)
    const srcStat = await fs.stat(path.join(storeDir, hash))
    const dstStat = await fs.stat(dest)
    expect(dstStat.ino).toBe(srcStat.ino)
  })

  it('is idempotent — linking to existing dest does not throw', async () => {
    const filePath = await writeFile('link-idem.txt', 'data')
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)

    const dest = path.join(tmpDir, 'dest.txt')
    await store.link(hash, dest)
    await store.link(hash, dest) // EEXIST should be swallowed
  })

  it('falls back to copyFile when fs.link throws EXDEV (cross-device)', async () => {
    const content = 'cross device content'
    const filePath = await writeFile('exdev.txt', content)
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)

    const dest = path.join(tmpDir, 'exdev-dest.txt')

    // Simulate EXDEV — different filesystem/device
    const exdevErr = Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
    const linkSpy = vi.spyOn(fs, 'link').mockRejectedValueOnce(exdevErr)
    const copySpy = vi.spyOn(fs, 'copyFile')

    await store.link(hash, dest)

    expect(linkSpy).toHaveBeenCalled()
    expect(copySpy).toHaveBeenCalled()
    expect(await fs.readFile(dest, 'utf8')).toBe(content)

    vi.restoreAllMocks()
  })
})

describe('CASStore.verify', () => {
  it('returns true for an intact file', async () => {
    const filePath = await writeFile('verify.txt', 'verify me')
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)
    expect(await store.verify(hash)).toBe(true)
  })

  it('returns false for a tampered file', async () => {
    const filePath = await writeFile('tampered.txt', 'original')
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)

    // Corrupt the stored file
    await fs.writeFile(path.join(storeDir, hash), 'tampered!')
    expect(await store.verify(hash)).toBe(false)
  })

  it('returns false for a missing file', async () => {
    expect(await store.verify('nonexistent' + '0'.repeat(117))).toBe(false)
  })
})

describe('CASStore.stat', () => {
  it('returns file size and hash', async () => {
    const content = 'stat test'
    const filePath = await writeFile('stat.txt', content)
    const hash = await hashFile(filePath)
    await store.put(hash, filePath)

    const entry = await store.stat(hash)
    expect(entry.hash).toBe(hash)
    expect(entry.size).toBe(Buffer.byteLength(content))
    expect(typeof entry.addedAt).toBe('number')
  })
})

describe('CASStore.gc', () => {
  it('removes entries not in the reference set', async () => {
    const f1 = await writeFile('gc1.txt', 'file one')
    const f2 = await writeFile('gc2.txt', 'file two')
    const h1 = await hashFile(f1)
    const h2 = await hashFile(f2)

    await store.put(h1, f1)
    await store.put(h2, f2)

    // Keep only h1
    const freed = await store.gc(new Set([h1]))
    expect(freed).toBeGreaterThan(0)
    expect(await store.has(h1)).toBe(true)
    expect(await store.has(h2)).toBe(false)
  })

  it('returns 0 when store is empty', async () => {
    const freed = await store.gc(new Set())
    expect(freed).toBe(0)
  })
})

describe('CASStore.gcByTtl', () => {
  it('removes files older than the TTL cutoff', async () => {
    const f1 = await writeFile('old.txt', 'old file')
    const h1 = await hashFile(f1)
    await store.put(h1, f1)

    // Backdate the stored file's mtime by 8 days
    const stored = path.join(storeDir, h1)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(stored, eightDaysAgo, eightDaysAgo)

    const freed = await store.gcByTtl(7)
    expect(freed).toBeGreaterThan(0)
    expect(await store.has(h1)).toBe(false)
  })

  it('keeps files newer than the TTL cutoff', async () => {
    const f1 = await writeFile('new.txt', 'new file')
    const h1 = await hashFile(f1)
    await store.put(h1, f1)

    const freed = await store.gcByTtl(7)
    expect(freed).toBe(0)
    expect(await store.has(h1)).toBe(true)
  })

  it('returns 0 when store does not exist', async () => {
    const emptyStore = new CASStore(path.join(tmpDir, 'nonexistent'))
    expect(await emptyStore.gcByTtl(7)).toBe(0)
  })
})

describe('CASStore.stats', () => {
  it('counts files and total bytes', async () => {
    const f1 = await writeFile('s1.txt', 'aaa')
    const f2 = await writeFile('s2.txt', 'bbbbb')
    const h1 = await hashFile(f1)
    const h2 = await hashFile(f2)
    await store.put(h1, f1)
    await store.put(h2, f2)

    const s = await store.stats()
    expect(s.totalFiles).toBe(2)
    expect(s.totalSizeBytes).toBe(3 + 5)
    expect(s.storeDir).toBe(storeDir)
  })

  it('returns zeros when store does not exist', async () => {
    const emptyStore = new CASStore(path.join(tmpDir, 'nonexistent'))
    const s = await emptyStore.stats()
    expect(s.totalFiles).toBe(0)
    expect(s.totalSizeBytes).toBe(0)
  })
})

/**
 * @sandboxpm/store
 *
 * Content-Addressable Store (CAS) — the heart of sandboxpm.
 *
 * Architecture (mirrors pnpm's store):
 *
 *   ~/.sandboxpm/store/
 *   └── {sha512-hex}/        ← one entry per unique file content
 *       └── (the actual file bytes, stored once)
 *
 * When a package is "installed" into node_modules, each of its files
 * is hard-linked from the store entry — not copied. Multiple projects
 * referencing the same package@version share the exact same inodes.
 *
 * Hard links only work within the same filesystem/volume.
 * If the project is on a different volume than the store, fall back
 * to reflinks (copy-on-write) or regular copy, in that order.
 *
 * Key operations:
 *   - has(hash)         → check if a file is already in the store
 *   - put(hash, stream) → write a file into the store
 *   - link(hash, dest)  → hard-link a store entry to a destination path
 *   - verify(hash)      → re-verify integrity of a stored file
 *   - gc()              → remove unreferenced store entries
 */

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

// TODO: implement CASStore class with:
//   constructor(storeDir: string)
//   has(hash: string): Promise<boolean>
//   put(hash: string, sourcePath: string): Promise<void>
//   link(hash: string, destPath: string): Promise<void>
//     → try fs.link() first
//     → if EXDEV (cross-device), try reflink via 'reflink' npm package
//     → if reflink fails, fs.copyFile() as last resort
//   verify(hash: string): Promise<boolean>
//     → recompute sha512 of stored file, compare to hash
//   stat(hash: string): Promise<StoreEntry>
//   gc(referencedHashes: Set<string>): Promise<number>  → returns bytes freed
//   stats(): Promise<StoreStats>

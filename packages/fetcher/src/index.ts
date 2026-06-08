/**
 * @sandboxpm/fetcher
 *
 * Downloads package tarballs directly from the npm registry,
 * verifies their SHA-512 integrity against the registry metadata,
 * extracts them, and populates the CAS store via @sandboxpm/store.
 *
 * Flow for a single package:
 *   1. GET https://registry.npmjs.org/{name}/{version}
 *      → parse PackumentVersion to get tarball URL + shasum (sha512 preferred, sha1 fallback)
 *   2. Stream-download the .tgz to a temp file
 *   3. While streaming, compute sha512 of the raw bytes
 *   4. Compare computed hash to registry shasum — abort if mismatch
 *   5. Extract the .tgz; for each file in package/:
 *      a. Compute sha512 of the extracted file
 *      b. Call store.put(hash, filePath) if not already present
 *      c. Record hash → relative path mapping for the linker
 *   6. Emit a FetchResult with all file mappings + script definitions
 *
 * Concurrency: fetch N packages in parallel (default N=8, configurable).
 * Progress: emit events for CLI progress bars.
 *
 * The fetcher NEVER executes any scripts. It only reads file content.
 */

export interface PackageId {
  name: string
  version: string       // exact resolved version e.g. "4.18.2"
}

export interface PackageScript {
  lifecycle: 'preinstall' | 'install' | 'postinstall' | 'prepare'
  command: string       // raw script string from package.json
  inspectUrl: string    // https://unpkg.com/{name}@{version}/{scriptFile} for human inspection
}

export interface FileMapping {
  hash: string          // sha512 hex — key into CAS store
  relativePath: string  // path within node_modules/{name}/... e.g. "lib/index.js"
  mode: number          // file permission bits
  size: number
}

export interface FetchResult {
  packageId: PackageId
  files: FileMapping[]
  scripts: PackageScript[]   // discovered but NEVER executed here
  fromCache: boolean         // true if all files were already in store
}

// TODO: implement Fetcher class with:
//   constructor(store: CASStore, registries: RegistryConfig[], options?: FetcherOptions)
//   fetch(packages: PackageId[]): AsyncIterable<FetchResult>
//     → parallel with concurrency limit
//     → emits progress events
//   fetchOne(pkg: PackageId): Promise<FetchResult>
//   preflight(pkg: PackageId): Promise<PackumentVersion>
//     → only fetches metadata, no download
//
// TODO: implement buildInspectUrl(name: string, version: string, scriptCommand: string): string
//   → parse the script command to find the script file name
//   → return https://unpkg.com/{name}@{version}/{file}
//   → fallback to https://www.npmjs.com/package/{name}?activeTab=code

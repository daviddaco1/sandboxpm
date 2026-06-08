/**
 * @sandboxpm/resolver
 *
 * Resolves a package.json's dependency tree into a flat list of
 * exact package@version pairs, ready for the fetcher.
 *
 * Algorithm (simplified npm-style resolution):
 *   1. Read package.json { dependencies, devDependencies, optionalDependencies }
 *   2. For each dep range (e.g. "express": "^4.0.0"):
 *      a. Fetch packument from registry: GET /express (full doc with all versions)
 *      b. Find the highest version satisfying the semver range
 *      c. Read that version's own `dependencies` → recurse
 *   3. Deduplicate: if two subtrees need express@^4, resolve to one shared version
 *   4. Handle conflicts: if A needs lodash@^3 and B needs lodash@^4 → keep both
 *      (nested resolution, pnpm-style)
 *   5. Produce a ResolvedTree and a flat ResolvedPackage[] list
 *   6. Write sandboxpm.lock (deterministic JSON, sorted keys)
 *
 * Lockfile format:
 *   {
 *     "lockfileVersion": 1,
 *     "packages": {
 *       "express@4.18.2": {
 *         "resolved": "https://registry.npmjs.org/express/-/express-4.18.2.tgz",
 *         "integrity": "sha512-...",   ← sha512 from registry
 *         "dependencies": { "accepts": "~1.3.8", ... }
 *       }
 *     }
 *   }
 */

export interface DependencyRange {
  name: string
  range: string         // semver range string e.g. "^4.0.0"
  type: 'prod' | 'dev' | 'optional' | 'peer'
}

export interface ResolvedPackage {
  name: string
  version: string       // exact e.g. "4.18.2"
  resolved: string      // tarball URL
  integrity: string     // sha512 from registry (format: "sha512-<base64>")
  dependencies: Record<string, string>   // name → exact version (resolved)
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>       // raw scripts from package.json
  cpu?: string[]        // optional: platform constraints
  os?: string[]
}

export interface ResolvedTree {
  root: string          // path to project root
  packages: Map<string, ResolvedPackage>  // key: "name@version"
  directDeps: DependencyRange[]
  lockfileHash: string  // sha256 of the written lockfile
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
  scripts?: Record<string, string>  // stored for the script prompt, not executed
}

// TODO: implement Resolver class with:
//   constructor(registries: RegistryConfig[], options?: ResolverOptions)
//   resolve(projectDir: string): Promise<ResolvedTree>
//     → reads package.json
//     → resolves full tree (BFS with dedup map)
//     → writes sandboxpm.lock
//   resolveFromLock(lockfilePath: string): Promise<ResolvedTree>
//     → reads existing lockfile, skips registry calls
//   fetchPackument(name: string): Promise<Packument>
//     → GET registry/{name}
//     → cache in memory for the duration of the resolve()
//   selectVersion(packument: Packument, range: string): string | null
//     → uses semver.maxSatisfying()

/**
 * @sandboxpm/linker
 *
 * Builds the node_modules directory structure from the resolved
 * dependency tree and the CAS store. Uses hard links (not copies).
 *
 * Output structure (pnpm-style, non-flat):
 *
 *   node_modules/
 *   ├── express/                    ← symlink → .sandboxpm/express@4.18.2/node_modules/express
 *   ├── lodash/                     ← symlink → .sandboxpm/lodash@4.17.21/node_modules/lodash
 *   └── .sandboxpm/
 *       ├── express@4.18.2/
 *       │   └── node_modules/
 *       │       ├── express/        ← actual files, hard-linked from CAS store
 *       │       │   ├── index.js    ← hard link to ~/.sandboxpm/store/{sha512}
 *       │       │   └── package.json
 *       │       ├── accepts/        ← express's own dep, symlinked
 *       │       └── ...
 *       └── accepts@1.3.8/
 *           └── node_modules/
 *               └── accepts/        ← hard-linked from store
 *
 * Why this structure?
 *   - Only direct project dependencies are visible in the root node_modules
 *   - Prevents phantom dependency access (you can't require() something
 *     you didn't declare in your package.json)
 *   - Identical to how pnpm lays out modules
 *
 * Bin links:
 *   Packages with `bin` fields get their executables linked into
 *   node_modules/.bin/ as symlinks.
 */

export interface LinkOptions {
  projectDir: string
  includeDevDependencies: boolean
}

export interface LinkResult {
  linkedPackages: number
  hardLinksCreated: number
  symlinksCreated: number
  bytesFromStore: number     // bytes served from store (not downloaded)
}

// TODO: implement Linker class with:
//   constructor(store: CASStore, options?: LinkerOptions)
//   link(tree: ResolvedTree, fetchResults: Map<string, FetchResult>, opts: LinkOptions): Promise<LinkResult>
//     → for each package in tree:
//       1. mkdir -p node_modules/.sandboxpm/{name}@{version}/node_modules/{name}/
//       2. for each file in fetchResult.files:
//          store.link(hash, destPath)   ← hard link from CAS
//       3. create symlink in root node_modules/ for direct deps
//       4. create cross-links for transitive deps (each pkg's own node_modules/)
//     → link bin executables → node_modules/.bin/
//   unlink(projectDir: string): Promise<void>
//     → removes node_modules/.sandboxpm/ and root symlinks
//     → does NOT touch the store

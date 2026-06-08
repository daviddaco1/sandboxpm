/**
 * @sandboxpm/linker
 *
 * Builds pnpm-style non-flat node_modules using hard links from the CAS store.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { CASStore } from '@sandboxpm/store'
import type { ResolvedTree, ResolvedPackage } from '@sandboxpm/resolver'
import type { FetchResult } from '@sandboxpm/fetcher'

export interface LinkOptions {
  projectDir: string
  includeDevDependencies: boolean
}

export interface LinkResult {
  linkedPackages: number
  hardLinksCreated: number
  symlinksCreated: number
  bytesFromStore: number
}

export class Linker {
  private readonly store: CASStore

  constructor(store: CASStore) {
    this.store = store
  }

  async link(
    tree: ResolvedTree,
    fetchResults: Map<string, FetchResult>,
    opts: LinkOptions,
  ): Promise<LinkResult> {
    const { projectDir } = opts
    const nodeModules = path.join(projectDir, 'node_modules')
    const sandboxpmDir = path.join(nodeModules, '.sandboxpm')

    // Clean .sandboxpm directory if it exists
    await fs.rm(sandboxpmDir, { recursive: true, force: true })
    await fs.mkdir(sandboxpmDir, { recursive: true })
    await fs.mkdir(path.join(nodeModules, '.bin'), { recursive: true })

    const result: LinkResult = {
      linkedPackages: 0,
      hardLinksCreated: 0,
      symlinksCreated: 0,
      bytesFromStore: 0,
    }

    const directDepNames = new Set(tree.directDeps.map(d => d.name))

    // Step 1: For each resolved package, create its directory and hard-link files
    for (const [key, pkg] of tree.packages) {
      const fetchResult = fetchResults.get(key)
      if (!fetchResult) continue

      const pkgDir = path.join(sandboxpmDir, key, 'node_modules', pkg.name)
      await fs.mkdir(pkgDir, { recursive: true })

      // Hard-link each file from the CAS store
      for (const fileMapping of fetchResult.files) {
        const destPath = path.join(pkgDir, fileMapping.relativePath)
        await this.store.link(fileMapping.hash, destPath)

        // Restore file mode bits
        try {
          await fs.chmod(destPath, fileMapping.mode)
        } catch {
          // chmod may fail on some systems; non-fatal
        }

        result.hardLinksCreated++
        result.bytesFromStore += fileMapping.size
      }

      result.linkedPackages++
    }

    // Step 2: Symlink direct deps into root node_modules/
    for (const dep of tree.directDeps) {
      if (dep.type === 'dev' && !opts.includeDevDependencies) continue

      const resolvedVersion = this._findVersion(tree, dep.name)
      if (!resolvedVersion) continue

      const key = `${dep.name}@${resolvedVersion}`
      const targetDir = path.join(sandboxpmDir, key, 'node_modules', dep.name)
      const symlinkPath = path.join(nodeModules, dep.name)

      await this._ensureSymlink(targetDir, symlinkPath)
      result.symlinksCreated++
    }

    // Step 3: Symlink transitive deps inside each package's own node_modules/
    for (const [key, pkg] of tree.packages) {
      const pkgNodeModules = path.join(sandboxpmDir, key, 'node_modules')

      for (const [depName, depVersion] of Object.entries(pkg.dependencies)) {
        const depKey = `${depName}@${depVersion}`
        if (!tree.packages.has(depKey)) continue

        const targetDir = path.join(sandboxpmDir, depKey, 'node_modules', depName)
        const symlinkPath = path.join(pkgNodeModules, depName)

        // Don't create if it's the package itself (can happen with peer deps)
        if (symlinkPath === path.join(pkgNodeModules, pkg.name)) continue

        await this._ensureSymlink(targetDir, symlinkPath)
        result.symlinksCreated++
      }
    }

    // Step 4: Bin links
    for (const [key, pkg] of tree.packages) {
      if (!directDepNames.has(pkg.name)) continue

      const fetchResult = fetchResults.get(key)
      if (!fetchResult) continue

      const pkgDir = path.join(sandboxpmDir, key, 'node_modules', pkg.name)
      await this._linkBins(pkgDir, pkg, nodeModules, result)
    }

    return result
  }

  async unlink(projectDir: string): Promise<void> {
    const nodeModules = path.join(projectDir, 'node_modules')

    // Remove .sandboxpm/ dir
    await fs.rm(path.join(nodeModules, '.sandboxpm'), { recursive: true, force: true })

    // Remove root-level symlinks that point into .sandboxpm
    let entries: { name: string; isSymbolicLink(): boolean }[]
    try {
      entries = await fs.readdir(nodeModules, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isSymbolicLink()) continue
      const symlinkPath = path.join(nodeModules, entry.name)
      try {
        const target = await fs.readlink(symlinkPath)
        if (target.includes('.sandboxpm')) {
          await fs.rm(symlinkPath, { force: true })
        }
      } catch {
        // ignore
      }
    }
  }

  private _findVersion(tree: ResolvedTree, name: string): string | undefined {
    for (const key of tree.packages.keys()) {
      const pkg = tree.packages.get(key)
      if (pkg?.name === name) return pkg.version
    }
    return undefined
  }

  private async _ensureSymlink(target: string, symlinkPath: string): Promise<void> {
    await fs.mkdir(path.dirname(symlinkPath), { recursive: true })
    try {
      await fs.symlink(target, symlinkPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
      throw err
    }
  }

  private async _linkBins(
    pkgDir: string,
    pkg: ResolvedPackage,
    nodeModules: string,
    result: LinkResult,
  ): Promise<void> {
    const pkgJson = await this._readPackageJson(pkgDir)
    if (!pkgJson) return

    const bin = pkgJson.bin as string | Record<string, string> | undefined
    if (!bin) return

    const binDir = path.join(nodeModules, '.bin')
    const binEntries: Record<string, string> =
      typeof bin === 'string'
        ? { [pkg.name]: bin }
        : bin

    for (const [binName, binFile] of Object.entries(binEntries)) {
      const target = path.resolve(pkgDir, binFile)
      const symlinkPath = path.join(binDir, binName)
      await this._ensureSymlink(target, symlinkPath)
      try {
        await fs.chmod(target, 0o755)
      } catch {
        // chmod may fail if target doesn't exist yet or on some filesystems; non-fatal
      }
      result.symlinksCreated++
    }
  }

  private async _readPackageJson(pkgDir: string): Promise<Record<string, unknown> | null> {
    try {
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')
      return JSON.parse(content) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

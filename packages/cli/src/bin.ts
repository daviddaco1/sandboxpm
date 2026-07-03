#!/usr/bin/env node
/**
 * sandboxpm CLI entry point
 */

import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import * as path from 'path'
import * as fs from 'fs/promises'
import { realpathSync } from 'fs'
import { fileURLToPath } from 'url'
import * as semver from 'semver'
import Dockerode from 'dockerode'

import { loadRc, loadGlobalConfig, saveRc, saveGlobalConfig, defaultRc } from '@sandboxpm/config'
import type { GlobalConfig } from '@sandboxpm/config'
import { CASStore } from '@sandboxpm/store'
import { Fetcher } from '@sandboxpm/fetcher'
import { Resolver } from '@sandboxpm/resolver'
import type { ResolvedTree } from '@sandboxpm/resolver'
import { Linker } from '@sandboxpm/linker'
import { ScriptPrompt, SandboxRunner } from '@sandboxpm/scripts'
import type { FetchResult } from '@sandboxpm/fetcher'
import type { TaggedScript, ScriptRunResult } from '@sandboxpm/scripts'

const PKG_VERSION = '0.1.0'

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Returns true if every direct dep in `deps` is present in `tree` at a
 * version that satisfies its semver range. Returns false (stale) otherwise.
 */
function isLockfileFresh(
  tree: ResolvedTree,
  deps: Record<string, string>,
): boolean {
  for (const [name, range] of Object.entries(deps)) {
    // dist-tags like "latest" are not valid semver ranges — treat as stale
    if (!semver.validRange(range)) return false
    let found = false
    for (const pkg of tree.packages.values()) {
      if (pkg.name === name && semver.satisfies(pkg.version, range)) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

// ─── install ─────────────────────────────────────────────────────────────────

interface InstallFlags {
  prod?: boolean
  frozenLockfile?: boolean
  cwd?: string
}

export async function install(flags: InstallFlags = {}): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const startMs = Date.now()

  const rc = await loadRc(cwd)
  const globalConfig = await loadGlobalConfig()

  const store = new CASStore(globalConfig.storeDir)
  const resolver = new Resolver(rc.registries, { includeDev: !flags.prod })
  const fetcher = new Fetcher(store, rc.registries)
  const linker = new Linker(store)
  const runner = new SandboxRunner(new Dockerode(), rc, globalConfig.reportsDir)
  const scriptPrompt = new ScriptPrompt(rc, runner)

  // 1. Resolve — lockfile-first when available
  let spinner = ora('Resolving dependencies...').start()
  let tree: ResolvedTree

  try {
    const lockfilePath = path.join(cwd, 'sandboxpm.lock')
    let lockfileExists = false
    try { await fs.access(lockfilePath); lockfileExists = true } catch { /* ENOENT */ }

    // Read direct deps from package.json for freshness check
    let pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {}
    try {
      pkgJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'))
    } catch {
      spinner.fail(chalk.red('No package.json found'))
      process.exit(1)
    }
    const allDeps = { ...pkgJson.dependencies, ...(flags.prod ? {} : pkgJson.devDependencies) }

    if (lockfileExists) {
      const lockedTree = await resolver.resolveFromLock(lockfilePath)
      if (isLockfileFresh(lockedTree, allDeps)) {
        tree = lockedTree
        spinner.succeed(chalk.green(`Resolved ${tree.packages.size} packages (from lockfile)`))
      } else if (flags.frozenLockfile) {
        spinner.fail(chalk.red('Lockfile is stale — run without --frozen-lockfile to update it'))
        process.exit(1)
      } else {
        tree = await resolver.resolve(cwd)
        spinner.succeed(chalk.green(`Resolved ${tree.packages.size} packages`))
      }
    } else if (flags.frozenLockfile) {
      spinner.fail(chalk.red('No sandboxpm.lock found and --frozen-lockfile is set'))
      process.exit(1)
    } else {
      tree = await resolver.resolve(cwd)
      spinner.succeed(chalk.green(`Resolved ${tree.packages.size} packages`))
    }
  } catch (err) {
    spinner.fail(chalk.red(`Resolution failed: ${(err as Error).message}`))
    process.exit(1)
  }

  // 2. Fetch
  spinner = ora('Downloading packages...').start()
  const fetchResults = new Map<string, FetchResult>()
  let fromStoreCount = 0
  let downloadedBytes = 0

  try {
    let progressCount = 0
    fetcher.on('progress', () => {
      progressCount++
      spinner.text = chalk.cyan(`Downloading... ${progressCount}/${tree.packages.size}`)
    })

    for await (const result of fetcher.fetch([...tree.packages.values()])) {
      fetchResults.set(`${result.packageId.name}@${result.packageId.version}`, result)
      if (result.fromCache) {
        fromStoreCount++
      } else {
        downloadedBytes += result.files.reduce((sum, f) => sum + f.size, 0)
      }
    }
    const downloaded = fetchResults.size - fromStoreCount
    const bytesStr = downloaded > 0 ? ` (${formatBytes(downloadedBytes)})` : ''
    spinner.succeed(
      chalk.green(`Downloaded ${fetchResults.size} packages`) +
      chalk.gray(` (${downloaded} new${bytesStr}, ${fromStoreCount} from store)`)
    )
  } catch (err) {
    spinner.fail(chalk.red(`Download failed: ${(err as Error).message}`))
    process.exit(1)
  }

  // 3. Link
  spinner = ora('Linking node_modules...').start()
  let linkResult
  try {
    linkResult = await linker.link(tree, fetchResults, {
      projectDir: cwd,
      includeDevDependencies: !flags.prod,
    })
    spinner.succeed(chalk.green('node_modules ready'))
  } catch (err) {
    spinner.fail(chalk.red(`Linking failed: ${(err as Error).message}`))
    process.exit(1)
  }

  // 4. Script prompt — runs after linking so package files are present on disk
  const nodeModules = path.join(cwd, 'node_modules')
  const sandboxpmDir = path.join(nodeModules, '.sandboxpm')
  const allScripts: TaggedScript[] = []
  for (const result of fetchResults.values()) {
    const { name, version } = result.packageId
    const packageDir = path.join(sandboxpmDir, `${name}@${version}`, 'node_modules', name)
    for (const script of result.scripts) {
      allScripts.push({ ...script, name, version, packageDir })
    }
  }
  const scriptResults = await scriptPrompt.promptAll(allScripts)
  // Persist any whitelist/blacklist decisions the user made during the prompt
  if (allScripts.length > 0) {
    await saveRc(cwd, rc)
  }

  // 5. Summary
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  const newCount = fetchResults.size - fromStoreCount
  console.log()
  console.log(chalk.green(`✓ ${linkResult.linkedPackages} packages installed`))
  const bytesLabel = newCount > 0 ? ` (${formatBytes(downloadedBytes)})` : ''
  console.log(chalk.gray(`  ├── ${newCount} downloaded from registry${bytesLabel}`))
  console.log(chalk.gray(`  └── ${fromStoreCount} linked from store (0 bytes downloaded)`))

  if (scriptResults.length > 0) {
    const ranResults = scriptResults.filter(r => (r.decision === 'run' || r.decision === 'whitelisted') && r.sandboxReport?.status !== 'blocked')
    const succeeded  = ranResults.filter(r => (r.exitCode ?? 0) === 0)
    const failed     = ranResults.filter(r => (r.exitCode ?? 0) !== 0)
    const blocked    = scriptResults.filter(r => r.sandboxReport?.status === 'blocked')
    const skipped    = scriptResults.filter(r => r.decision === 'skip' || r.decision === 'blacklisted')
    const all = [...ranResults, ...skipped, ...blocked]
    console.log()
    console.log(chalk.yellow(`⚠  ${all.length} packages had install scripts:`))
    for (const r of succeeded) {
      const dur = r.durationMs ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ''
      const label = r.nativeRun ? 'ran natively (no sandbox)' : 'ran in sandbox'
      console.log(chalk.green(`  ├── ✓ ${r.packageId} ${r.lifecycle} — ${label}${dur}`))
    }
    for (const r of failed) {
      const dur = r.durationMs ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ''
      const label = r.nativeRun ? 'native run' : 'script'
      console.log(chalk.yellow(`  ├── ✗ ${r.packageId} ${r.lifecycle} — ${label} exited ${r.exitCode}${dur}`))
    }
    for (const r of skipped) {
      console.log(chalk.gray(`  ├── – ${r.packageId} ${r.lifecycle} — skipped by user`))
    }
    for (const r of blocked) {
      const reason = r.sandboxReport?.unexpectedActivity[0] ?? 'unexpected activity'
      console.log(chalk.red(`  └── ✗ ${r.packageId} ${r.lifecycle} — blocked (${reason})`))
    }
  }

  console.log()
  console.log(chalk.green(`✓ Done in ${elapsed}s`))
}

// ─── add ──────────────────────────────────────────────────────────────────────

export async function addPackages(packages: string[], flags: { cwd?: string; dev?: boolean }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()

  const pkgJsonPath = path.join(cwd, 'package.json')
  let pkgJson: Record<string, unknown>
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>
  } catch {
    console.error(chalk.red('No package.json found. Run `sandboxpm init` first.'))
    process.exit(1)
  }

  const depKey = flags.dev ? 'devDependencies' : 'dependencies'
  const deps = (pkgJson[depKey] ?? {}) as Record<string, string>

  for (const pkg of packages) {
    const lastAt = pkg.lastIndexOf('@')
    const [name, version] = lastAt > 0
      ? [pkg.slice(0, lastAt), pkg.slice(lastAt + 1)]
      : [pkg, 'latest']
    deps[name] = version
  }

  pkgJson[depKey] = deps
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')
  await install({ cwd })
}

// ─── remove ───────────────────────────────────────────────────────────────────

export async function removePackages(packages: string[], flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const pkgJsonPath = path.join(cwd, 'package.json')

  let pkgJson: Record<string, unknown>
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>
  } catch {
    console.error(chalk.red('No package.json found.'))
    process.exit(1)
  }

  for (const pkg of packages) {
    const lastAt = pkg.lastIndexOf('@')
    const name = lastAt > 0 ? pkg.slice(0, lastAt) : pkg
    for (const depKey of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const deps = pkgJson[depKey] as Record<string, string> | undefined
      if (deps && name in deps) {
        delete deps[name]
        console.log(chalk.gray(`Removed ${name} from ${depKey}`))
      }
    }
  }

  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')
  const linker = new Linker(new CASStore((await loadGlobalConfig()).storeDir))
  await linker.unlink(cwd)
  await install({ cwd })
}

// ─── init ─────────────────────────────────────────────────────────────────────

export async function init(flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rcPath = path.join(cwd, '.sandboxpmrc')

  try {
    await fs.access(rcPath)
    console.log(chalk.yellow('.sandboxpmrc already exists, skipping'))
    return
  } catch {
    // file doesn't exist, create it
  }

  const rc = defaultRc()
  await saveRc(cwd, rc)
  console.log(chalk.green('✓ Created .sandboxpmrc with safe defaults'))
}

// ─── whitelist / blacklist ────────────────────────────────────────────────────

export async function whitelistAdd(pkg: string, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rc = await loadRc(cwd)
  if (!rc.whitelist.includes(pkg)) {
    rc.whitelist.push(pkg)
    await saveRc(cwd, rc)
    console.log(chalk.green(`✓ Added ${pkg} to whitelist`))
  } else {
    console.log(chalk.gray(`${pkg} is already whitelisted`))
  }
}

export async function whitelistRemove(pkg: string, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rc = await loadRc(cwd)
  const idx = rc.whitelist.indexOf(pkg)
  if (idx >= 0) {
    rc.whitelist.splice(idx, 1)
    await saveRc(cwd, rc)
    console.log(chalk.green(`✓ Removed ${pkg} from whitelist`))
  } else {
    console.log(chalk.gray(`${pkg} is not whitelisted`))
  }
}

// ─── cache ────────────────────────────────────────────────────────────────────

export async function cacheClean(): Promise<void> {
  const globalConfig = await loadGlobalConfig()
  const rc = await loadRc(process.cwd())
  const store = new CASStore(globalConfig.storeDir)
  let freed = await store.gc(new Set())
  if (rc.cache.ttlDays > 0) {
    freed += await store.gcByTtl(rc.cache.ttlDays)
  }
  console.log(chalk.green(`✓ Freed ${(freed / 1024 / 1024).toFixed(1)} MB from store`))
}

async function cacheStats(): Promise<void> {
  const globalConfig = await loadGlobalConfig()
  const store = new CASStore(globalConfig.storeDir)
  const stats = await store.stats()
  console.log(chalk.cyan(`Store: ${globalConfig.storeDir}`))
  console.log(chalk.cyan(`Files: ${stats.totalFiles}`))
  console.log(chalk.cyan(`Size:  ${(stats.totalSizeBytes / 1024 / 1024).toFixed(1)} MB`))
}

async function cacheWarm(flags: { cwd?: string } = {}): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rc = await loadRc(cwd)
  const globalConfig = await loadGlobalConfig()
  const store = new CASStore(globalConfig.storeDir)
  const fetcher = new Fetcher(store, rc.registries)
  const resolver = new Resolver(rc.registries)

  let spinner = ora('Resolving...').start()
  let tree: ResolvedTree
  try {
    const lockfilePath = path.join(cwd, 'sandboxpm.lock')
    try {
      await fs.access(lockfilePath)
      tree = await resolver.resolveFromLock(lockfilePath)
    } catch {
      tree = await resolver.resolve(cwd)
    }
    spinner.succeed(chalk.green(`Resolved ${tree.packages.size} packages`))
  } catch (err) {
    spinner.fail(chalk.red(`Resolution failed: ${(err as Error).message}`))
    process.exit(1)
  }

  spinner = ora('Warming cache...').start()
  let count = 0
  try {
    for await (const _ of fetcher.fetch([...tree.packages.values()])) {
      count++
      spinner.text = chalk.cyan(`Warming cache... ${count}/${tree.packages.size}`)
    }
    spinner.succeed(chalk.green(`${count} packages cached`))
  } catch (err) {
    spinner.fail(chalk.red(`Cache warm failed: ${(err as Error).message}`))
    process.exit(1)
  }
}

// ─── audit ────────────────────────────────────────────────────────────────────

async function auditReports(): Promise<void> {
  const globalConfig = await loadGlobalConfig()
  let files: string[]
  try {
    files = (await fs.readdir(globalConfig.reportsDir)).filter(f => f.endsWith('.json'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(chalk.gray('No audit reports found.'))
      return
    }
    throw err
  }

  if (files.length === 0) {
    console.log(chalk.gray('No audit reports found.'))
    return
  }

  console.log(chalk.cyan(`\n${files.length} script run(s):\n`))
  for (const file of files.sort()) {
    try {
      const r = JSON.parse(
        await fs.readFile(path.join(globalConfig.reportsDir, file), 'utf8')
      ) as ScriptRunResult
      const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'
      const exitIcon = r.exitCode === 0 ? chalk.green('✓') : chalk.red('✗')
      // Real syscall-audit data only exists when sandbox.auditSyscalls was on and
      // the report's Linux trace parsed successfully — otherwise `status` is the
      // cosmetic default, so say so rather than implying every run was checked.
      const auditNote = r.sandboxReport !== undefined && r.sandboxReport.audited !== true
        ? chalk.gray(' (unaudited)')
        : ''
      console.log(
        `${exitIcon} ${r.packageId} ${r.lifecycle}` +
        ` — ${r.decision} | exit=${r.exitCode ?? '-'} | ${dur}` +
        ` | ${r.sandboxReport?.status ?? '-'}${auditNote}`
      )
    } catch {
      // skip malformed report files
    }
  }
}

// ─── commander setup ──────────────────────────────────────────────────────────

program
  .name('sandboxpm')
  .description('Secure, zero-trust Node.js package manager')
  .version(PKG_VERSION)
  .option('--cwd <path>', 'Run as if in this directory')
  .option('--no-color', 'Disable color output')
  .option('--json', 'Machine-readable JSON output')
  .option('--verbose', 'Debug logging')

program
  .command('install')
  .alias('i')
  .description('Install all dependencies from package.json')
  .option('--prod', 'Install production dependencies only')
  .option('--frozen-lockfile', 'Error if lockfile is out of date')
  .action(async (cmdFlags) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    const flags = cmdFlags as InstallFlags
    if (cwd) flags.cwd = cwd
    await install(flags)
  })

program
  .command('add <packages...>')
  .description('Add and install one or more packages')
  .option('-D, --dev', 'Add to devDependencies')
  .action(async (packages: string[], cmdFlags: { dev?: boolean }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    const opts: { dev?: boolean; cwd?: string } = { ...cmdFlags }
    if (cwd) opts.cwd = cwd
    await addPackages(packages, opts)
  })

program
  .command('remove <packages...>')
  .alias('rm')
  .description('Remove packages')
  .action(async (packages: string[]) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await removePackages(packages, cwd ? { cwd } : {})
  })

program
  .command('init')
  .description('Initialize .sandboxpmrc in current project')
  .action(async () => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await init(cwd ? { cwd } : {})
  })

program
  .command('audit')
  .description('Show a report of all sandboxed script runs')
  .action(auditReports)

const whitelist = program.command('whitelist').description('Manage script whitelist')
whitelist
  .command('add <package>')
  .description('Trust a package\'s scripts permanently')
  .action(async (pkg: string) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await whitelistAdd(pkg, cwd ? { cwd } : {})
  })
whitelist
  .command('remove <package>')
  .description('Remove a package from the whitelist')
  .action(async (pkg: string) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await whitelistRemove(pkg, cwd ? { cwd } : {})
  })

const cache = program.command('cache').description('Manage the CAS store')
cache.command('clean').description('Remove all unreferenced store entries').action(cacheClean)
cache.command('stats').description('Show store size and file count').action(cacheStats)
cache
  .command('warm')
  .description('Pre-download all packages into the store without linking')
  .action(async () => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await cacheWarm(cwd ? { cwd } : {})
  })

// ─── config ──────────────────────────────────────────────────────────────────

const GLOBAL_CONFIG_KEYS: Array<keyof GlobalConfig> = ['storeDir', 'cacheDir', 'reportsDir']

const configCmd = program.command('config').description('Manage global sandboxpm configuration')
configCmd
  .command('get [key]')
  .description('Show global config, or a specific key')
  .action(async (key?: string) => {
    const gc = await loadGlobalConfig()
    if (key) {
      if (!GLOBAL_CONFIG_KEYS.includes(key as keyof GlobalConfig)) {
        console.error(chalk.red(`Unknown key "${key}". Valid keys: ${GLOBAL_CONFIG_KEYS.join(', ')}`))
        process.exit(1)
      }
      console.log(gc[key as keyof GlobalConfig])
    } else {
      console.log(JSON.stringify(gc, null, 2))
    }
  })
configCmd
  .command('set <key> <value>')
  .description('Set a global config value (storeDir, cacheDir, reportsDir)')
  .action(async (key: string, value: string) => {
    if (!GLOBAL_CONFIG_KEYS.includes(key as keyof GlobalConfig)) {
      console.error(chalk.red(`Unknown key "${key}". Valid keys: ${GLOBAL_CONFIG_KEYS.join(', ')}`))
      process.exit(1)
    }
    const gc = await loadGlobalConfig()
    const updated: GlobalConfig = { ...gc, [key]: value }
    await saveGlobalConfig(updated)
    console.log(chalk.green(`✓ ${key} = ${value}`))
  })

// Apply --no-color and --verbose before every action
program.hook('preAction', () => {
  const opts = program.opts<{ color?: boolean; verbose?: boolean }>()
  if (opts.color === false) chalk.level = 0
})

function realpath(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

const isMain = process.argv[1] !== undefined && (() => {
  const argv1 = realpath(process.argv[1])
  const self  = realpath(fileURLToPath(import.meta.url))
  return argv1 === self ||
    argv1.endsWith('/sandboxpm')  ||
    argv1.endsWith('\\sandboxpm') ||
    argv1.endsWith('/sandboxpm.js')  ||
    argv1.endsWith('\\sandboxpm.js')
})()

if (isMain) {
  program.parseAsync(process.argv).catch(err => {
    console.error(chalk.red((err as Error).message))
    process.exit(1)
  })
}

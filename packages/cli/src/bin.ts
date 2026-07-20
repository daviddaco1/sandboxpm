#!/usr/bin/env node
/**
 * sandboxpm CLI entry point
 */

import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'node:os'
import { realpathSync } from 'fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'url'
import * as semver from 'semver'
import Dockerode from 'dockerode'

import { loadRc, loadGlobalConfig, saveRc, saveGlobalConfig, defaultRc, getHostPlatform, matchesHostPlatform } from '@sandboxpm/config'
import type { GlobalConfig, HostPlatform } from '@sandboxpm/config'
import { CASStore } from '@sandboxpm/store'
import { Fetcher } from '@sandboxpm/fetcher'
import { Resolver } from '@sandboxpm/resolver'
import type { ResolvedTree, ResolvedPackage, DependencyRange } from '@sandboxpm/resolver'
import { Linker } from '@sandboxpm/linker'
import { ScriptPrompt, SandboxRunner, PackageRiskPrompt } from '@sandboxpm/scripts'
import type { FetchResult } from '@sandboxpm/fetcher'
import type { TaggedScript, ScriptRunResult } from '@sandboxpm/scripts'
import type { PackageRiskResult } from '@sandboxpm/scripts'

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
  const resolver = new Resolver(rc.registries, { includeDev: !flags.prod, trustedPackages: rc.trustedPackages })
  const fetcher = new Fetcher(store, rc.registries)
  const linker = new Linker(store)
  const runner = new SandboxRunner(new Dockerode(), rc, globalConfig.reportsDir)
  const scriptPrompt = new ScriptPrompt(rc, runner)
  const riskPrompt = new PackageRiskPrompt(rc)

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

  // 1b. Package trust/block check — runs before any tarball is downloaded.
  // The blocklist applies to lockfile-based resolves too (pure name comparison,
  // no registry access needed); typosquat/low-trust riskFindings only exist
  // when tree came from a live resolver.resolve() call.
  const blockedHit = [...tree.packages.values()].find(pkg => rc.blockedPackages.includes(pkg.name))
  if (blockedHit) {
    console.error(chalk.red(`✗ Install aborted: "${blockedHit.name}" is in policies.blockedPackages`))
    process.exit(1)
    return
  }

  if (tree.riskFindings.length > 0) {
    let riskResults: PackageRiskResult[]
    try {
      riskResults = await riskPrompt.promptAll(tree.riskFindings)
    } catch (err) {
      console.error(chalk.red((err as Error).message))
      process.exit(1)
      return
    }
    await saveRc(cwd, rc)
    for (const { finding, decision } of riskResults) {
      try {
        await fs.mkdir(globalConfig.reportsDir, { recursive: true })
        await fs.writeFile(
          path.join(globalConfig.reportsDir, `risk-${finding.name.replace(/\//g, '-')}-${Date.now()}.json`),
          JSON.stringify({ ...finding, decision }, null, 2),
        )
      } catch {
        // Non-fatal — audit trail is best-effort
      }
    }
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

  // 2b. Fetch sandbox-platform optional deps for packages with install scripts.
  // The Linux sandbox container always runs on linux/x64/musl (Alpine). When the host is
  // not Linux (e.g. macOS), platform-specific optional deps like @esbuild/linux-x64 are
  // filtered out of the main fetch by matchesHostPlatform. Without them, those packages'
  // postinstall scripts fail inside the container. We fetch them here, before linking, so
  // the linker wires them up as siblings and the sandbox scanner can find them.
  const host: HostPlatform = getHostPlatform()
  if (host.os !== 'linux') {
    const SANDBOX_PLATFORM: HostPlatform = { os: 'linux', cpu: 'x64', libc: 'musl' }
    for (const [key, pkg] of tree.packages) {
      const fetched = fetchResults.get(key)
      if (!fetched || fetched.scripts.length === 0) continue
      for (const [depName, depVersion] of Object.entries(pkg.optionalDependencies ?? {})) {
        const depKey = `${depName}@${depVersion}`
        if (fetchResults.has(depKey)) continue
        const depPkg = tree.packages.get(depKey)
        if (!depPkg) continue
        if (!matchesHostPlatform(depPkg, SANDBOX_PLATFORM)) continue
        try {
          const result = await fetcher.fetchOne(depPkg)
          fetchResults.set(depKey, result)
        } catch {
          // Non-fatal — sandbox script may still fail, but host install continues
        }
      }
    }
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

export async function init(flags: { cwd?: string; yes?: boolean }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const yes = flags.yes ?? false
  const created: string[] = []
  const skipped: string[] = []

  // ── package.json ──────────────────────────────────────────────────────────
  const pkgJsonPath = path.join(cwd, 'package.json')
  let pkgJsonExists = false
  try { await fs.access(pkgJsonPath); pkgJsonExists = true } catch { /* ENOENT */ }

  if (pkgJsonExists) {
    skipped.push('package.json')
  } else {
    const defaultName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    let name = defaultName, version = '1.0.0', description = '', author = '', license = 'MIT'

    if (!yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        name        = (await rl.question(`package name: (${defaultName}) `)).trim() || defaultName
        version     = (await rl.question(`version: (1.0.0) `)).trim() || '1.0.0'
        description = (await rl.question(`description: `)).trim()
        author      = (await rl.question(`author: `)).trim()
        license     = (await rl.question(`license: (MIT) `)).trim() || 'MIT'
      } finally {
        rl.close()
      }
    }

    const pkg: Record<string, unknown> = { name, version }
    if (description) pkg['description'] = description
    if (author)      pkg['author'] = author
    pkg['license'] = license

    await fs.writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
    created.push('package.json')
  }

  // ── .sandboxpmrc ──────────────────────────────────────────────────────────
  const rcPath = path.join(cwd, '.sandboxpmrc')
  let rcExists = false
  try { await fs.access(rcPath); rcExists = true } catch { /* ENOENT */ }

  if (rcExists) {
    skipped.push('.sandboxpmrc')
  } else {
    await saveRc(cwd, defaultRc())
    created.push('.sandboxpmrc')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  for (const f of created) console.log(chalk.green(`✓ Created ${f}`))
  for (const f of skipped) console.log(chalk.gray(`  ${f} already exists, skipping`))
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

// ─── trust / block (package-level, distinct from the script whitelist/blacklist above) ─────

export async function trustAdd(pkg: string, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rc = await loadRc(cwd)
  if (!rc.trustedPackages.includes(pkg)) {
    rc.trustedPackages.push(pkg)
    await saveRc(cwd, rc)
    console.log(chalk.green(`✓ Added ${pkg} to trustedPackages`))
  } else {
    console.log(chalk.gray(`${pkg} is already trusted`))
  }
}

export async function trustRemove(pkg: string, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rc = await loadRc(cwd)
  const idx = rc.trustedPackages.indexOf(pkg)
  if (idx >= 0) {
    rc.trustedPackages.splice(idx, 1)
    await saveRc(cwd, rc)
    console.log(chalk.green(`✓ Removed ${pkg} from trustedPackages`))
  } else {
    console.log(chalk.gray(`${pkg} is not trusted`))
  }
}

export async function blockAdd(pkg: string, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rc = await loadRc(cwd)
  if (!rc.blockedPackages.includes(pkg)) {
    rc.blockedPackages.push(pkg)
    await saveRc(cwd, rc)
    console.log(chalk.green(`✓ Added ${pkg} to blockedPackages`))
  } else {
    console.log(chalk.gray(`${pkg} is already blocked`))
  }
}

export async function blockRemove(pkg: string, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const rc = await loadRc(cwd)
  const idx = rc.blockedPackages.indexOf(pkg)
  if (idx >= 0) {
    rc.blockedPackages.splice(idx, 1)
    await saveRc(cwd, rc)
    console.log(chalk.green(`✓ Removed ${pkg} from blockedPackages`))
  } else {
    console.log(chalk.gray(`${pkg} is not blocked`))
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

  const scriptFiles = files.filter(f => !f.startsWith('risk-')).sort()
  const riskFiles = files.filter(f => f.startsWith('risk-')).sort()

  console.log(chalk.cyan(`\n${scriptFiles.length} script run(s):\n`))
  for (const file of scriptFiles) {
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

  if (riskFiles.length > 0) {
    console.log(chalk.cyan(`\n${riskFiles.length} package risk report(s):\n`))
    for (const file of riskFiles) {
      try {
        const r = JSON.parse(
          await fs.readFile(path.join(globalConfig.reportsDir, file), 'utf8')
        ) as { name: string; version: string; reasons: string[]; severity: string; decision: string }
        const severityIcon = r.severity === 'high' ? chalk.red('✗') : chalk.yellow('⚠')
        console.log(
          `${severityIcon} ${r.name}@${r.version} — ${r.severity} | decision=${r.decision} | ${r.reasons.join(', ')}`
        )
      } catch {
        // skip malformed report files
      }
    }
  }
}

// ─── ls / list ────────────────────────────────────────────────────────────────

export async function listPackages(flags: { cwd?: string; depth?: number; json?: boolean }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const lockPath = path.join(cwd, 'sandboxpm.lock')

  const rc = await loadRc(cwd)
  const resolver = new Resolver(rc.registries)

  let tree: ResolvedTree
  try {
    tree = await resolver.resolveFromLock(lockPath)
  } catch {
    console.error(chalk.red('✗ No sandboxpm.lock found. Run `sandboxpm install` first.'))
    process.exit(1)
    return
  }

  if (flags.json) {
    const obj: Record<string, { version: string; resolved: string }> = {}
    for (const [id, pkg] of tree.packages) {
      obj[id] = { version: pkg.version, resolved: pkg.resolved }
    }
    console.log(JSON.stringify(obj, null, 2))
    return
  }

  let pkgName = path.basename(cwd)
  try {
    const p = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { name?: string }
    if (p.name) pkgName = p.name
  } catch { /* no package.json */ }

  const maxDepth = flags.depth ?? 0
  console.log(chalk.bold(pkgName))

  const directDeps = tree.directDeps
  for (let i = 0; i < directDeps.length; i++) {
    const dep = directDeps[i]
    if (!dep) continue
    const isLast = i === directDeps.length - 1
    const prefix = isLast ? '└── ' : '├── '

    let resolvedPkg: ResolvedPackage | undefined
    for (const [, pkg] of tree.packages) {
      if (pkg.name === dep.name) { resolvedPkg = pkg; break }
    }

    if (!resolvedPkg) {
      console.log(prefix + chalk.red(`${dep.name}@${dep.range} (not installed)`))
      continue
    }

    const isBlacklisted = rc.blacklist.includes(dep.name)
    const versionStr = `${dep.name}@${resolvedPkg.version}`
    const label = isBlacklisted ? chalk.red(versionStr + ' [blacklisted]') : chalk.cyan(versionStr)
    console.log(prefix + label)

    if (maxDepth > 0) {
      const transitive = Object.entries(resolvedPkg.dependencies)
      for (let j = 0; j < transitive.length; j++) {
        const entry = transitive[j]
        if (!entry) continue
        const [tName, tVersion] = entry
        const isLastT = j === transitive.length - 1
        const childPrefix = (isLast ? '    ' : '│   ') + (isLastT ? '└── ' : '├── ')
        console.log(childPrefix + `${tName}@${tVersion}`)
      }
    }
  }

  console.log()
  console.log(chalk.gray(`${tree.packages.size} packages total`))
}

// ─── why ──────────────────────────────────────────────────────────────────────

export async function why(pkgName: string, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const lockPath = path.join(cwd, 'sandboxpm.lock')

  const rc = await loadRc(cwd)
  const resolver = new Resolver(rc.registries)

  let tree: ResolvedTree
  try {
    tree = await resolver.resolveFromLock(lockPath)
  } catch {
    console.error(chalk.red('✗ No sandboxpm.lock found. Run `sandboxpm install` first.'))
    process.exit(1)
    return
  }

  const installedPkg = [...tree.packages.values()].find(p => p.name === pkgName)
  if (!installedPkg) {
    console.log(chalk.yellow(`"${pkgName}" is not in the dependency tree`))
    return
  }

  const directDep = tree.directDeps.find((d: DependencyRange) => d.name === pkgName)
  if (directDep) {
    console.log(chalk.bold(pkgName) + chalk.gray(` ${installedPkg.version}`) + ' — ' + chalk.green('direct dependency'))
    return
  }

  // Build reverse dependency map: name → packages that depend on it
  const reverseDeps = new Map<string, Array<{ name: string; version: string }>>()
  for (const pkg of tree.packages.values()) {
    for (const depName of Object.keys(pkg.dependencies)) {
      let list = reverseDeps.get(depName)
      if (!list) { list = []; reverseDeps.set(depName, list) }
      list.push({ name: pkg.name, version: pkg.version })
    }
  }

  console.log(chalk.bold(`Why is ${pkgName} installed?\n`))

  const directDependents = reverseDeps.get(pkgName) ?? []
  if (directDependents.length === 0) {
    console.log(chalk.gray('Not depended on by any package in the tree'))
    return
  }

  for (const dep of directDependents) {
    const isDirect = tree.directDeps.some((d: DependencyRange) => d.name === dep.name)
    const depLabel = isDirect ? chalk.cyan(dep.name) : dep.name
    console.log(`${pkgName} ← ${depLabel}@${dep.version}${isDirect ? ' (direct)' : ''}`)
  }
}

// ─── outdated ─────────────────────────────────────────────────────────────────

export async function outdated(flags: { cwd?: string; json?: boolean }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const lockPath = path.join(cwd, 'sandboxpm.lock')

  const rc = await loadRc(cwd)
  const resolver = new Resolver(rc.registries)

  let tree: ResolvedTree
  try {
    tree = await resolver.resolveFromLock(lockPath)
  } catch {
    console.error(chalk.red('✗ No sandboxpm.lock found. Run `sandboxpm install` first.'))
    process.exit(1)
    return
  }

  const spinner = ora('Checking for updates...').start()

  const results: Array<{ name: string; current: string; wanted: string; latest: string }> = []

  for (const dep of tree.directDeps) {
    try {
      const packument = await resolver.fetchPackument(dep.name)
      const distTags = packument['dist-tags']
      const latest = distTags['latest'] ?? ''
      const wanted = resolver.selectVersion(packument, dep.range) ?? latest

      let currentPkg: ResolvedPackage | undefined
      for (const [, pkg] of tree.packages) {
        if (pkg.name === dep.name) { currentPkg = pkg; break }
      }
      const current = currentPkg?.version ?? 'not installed'

      if (current !== latest) {
        results.push({ name: dep.name, current, wanted, latest })
      }
    } catch { /* skip unreachable packages */ }
  }

  spinner.stop()

  if (flags.json) { console.log(JSON.stringify(results, null, 2)); return }

  if (results.length === 0) {
    console.log(chalk.green('✓ All packages are up to date'))
    return
  }

  const col1 = Math.max(8, ...results.map(r => r.name.length))
  const col2 = Math.max(8, ...results.map(r => r.current.length))
  const col3 = Math.max(7, ...results.map(r => r.wanted.length))

  console.log(chalk.gray(
    'Package'.padEnd(col1) + '  ' + 'Current'.padEnd(col2) + '  ' + 'Wanted'.padEnd(col3) + '  Latest'
  ))
  for (const r of results) {
    console.log(
      chalk.bold(r.name.padEnd(col1)) + '  ' +
      chalk.yellow(r.current.padEnd(col2)) + '  ' +
      chalk.yellow(r.wanted.padEnd(col3)) + '  ' +
      chalk.green(r.latest)
    )
  }
}

// ─── info ─────────────────────────────────────────────────────────────────────

export async function info(pkgSpec: string, flags: { json?: boolean }): Promise<void> {
  const atIdx = pkgSpec.lastIndexOf('@')
  const name = atIdx > 0 ? pkgSpec.slice(0, atIdx) : pkgSpec
  const versionSpec = atIdx > 0 ? pkgSpec.slice(atIdx + 1) : 'latest'

  const rc = await loadRc(process.cwd())
  const resolver = new Resolver(rc.registries)

  const spinner = ora(`Fetching ${name}...`).start()
  let packument: Awaited<ReturnType<typeof resolver.fetchPackument>>
  try {
    packument = await resolver.fetchPackument(name)
  } catch (err) {
    spinner.stop()
    console.error(chalk.red(`✗ ${(err as Error).message}`))
    process.exit(1)
    return
  }
  spinner.stop()

  const exactVersion = resolver.selectVersion(packument, versionSpec) ?? packument['dist-tags']['latest']
  if (!exactVersion) {
    console.error(chalk.red(`✗ Version "${versionSpec}" not found for ${name}`))
    process.exit(1)
    return
  }

  const pkg = packument.versions[exactVersion]
  if (!pkg) {
    console.error(chalk.red(`✗ Version "${exactVersion}" metadata not available`))
    process.exit(1)
    return
  }

  if (flags.json) { console.log(JSON.stringify(pkg, null, 2)); return }

  console.log(chalk.bold(`${pkg.name}@${pkg.version}`))
  const distTags = packument['dist-tags']
  const versions = Object.keys(packument.versions)
  console.log()
  console.log(chalk.gray('dist-tags:'))
  for (const [tag, ver] of Object.entries(distTags)) {
    console.log(`  ${tag}: ${ver}`)
  }
  console.log()
  console.log(chalk.gray(`versions:  ${versions.length} published`))
  console.log(chalk.gray(`tarball:   ${pkg.dist.tarball}`))
  if (pkg.dist.integrity) console.log(chalk.gray(`integrity: ${pkg.dist.integrity}`))
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    console.log(chalk.gray(`deps:      ${Object.keys(pkg.dependencies).length}`))
  }
}

// ─── search ───────────────────────────────────────────────────────────────────

export async function search(query: string, flags: { json?: boolean }): Promise<void> {
  const rc = await loadRc(process.cwd())
  const firstReg = rc.registries[0]
  const registryUrl = (firstReg?.url ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const token = firstReg?.token

  const spinner = ora(`Searching for "${query}"...`).start()

  interface SearchResultPackage {
    name: string; version: string; description?: string; author?: { name?: string }
  }
  interface SearchResponse { objects: Array<{ package: SearchResultPackage }>; total: number }

  let data: SearchResponse
  try {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await fetch(`${registryUrl}/-/v1/search?text=${encodeURIComponent(query)}&size=20`, { headers })
    if (!res.ok) throw new Error(`Registry: ${res.status} ${res.statusText}`)
    data = await res.json() as SearchResponse
  } catch (err) {
    spinner.stop()
    console.error(chalk.red(`✗ ${(err as Error).message}`))
    process.exit(1)
    return
  }
  spinner.stop()

  if (flags.json) { console.log(JSON.stringify(data.objects, null, 2)); return }

  console.log(chalk.gray(`Found ${data.total} packages\n`))
  for (const r of data.objects) {
    const pkg = r.package
    const author = pkg.author?.name ? chalk.gray(` by ${pkg.author.name}`) : ''
    console.log(chalk.bold(pkg.name) + chalk.gray(`@${pkg.version}`) + author)
    if (pkg.description) console.log('  ' + pkg.description)
    console.log()
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────

export async function runScript(
  scriptName: string,
  scriptArgs: string[],
  flags: { cwd?: string; sandbox?: boolean }
): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const pkgPath = path.join(cwd, 'package.json')

  let pkgJson: { name?: string; version?: string; scripts?: Record<string, string> }
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
  } catch {
    console.error(chalk.red('✗ No package.json found. Run `sandboxpm init` first.'))
    process.exit(1)
    return
  }

  const command = pkgJson.scripts?.[scriptName]
  if (!command) {
    console.error(chalk.red(`✗ Script "${scriptName}" not found in package.json`))
    const available = pkgJson.scripts ? Object.keys(pkgJson.scripts) : []
    if (available.length > 0) console.log(chalk.gray('Available: ' + available.join(', ')))
    process.exit(1)
    return
  }

  console.log(chalk.gray(`> ${command}\n`))

  if (flags.sandbox) {
    const rc = await loadRc(cwd)
    const globalConfig = await loadGlobalConfig()
    const runner = new SandboxRunner(new Dockerode(), rc, globalConfig.reportsDir)

    const taggedScript: TaggedScript = {
      name: pkgJson.name ?? path.basename(cwd),
      version: pkgJson.version ?? '0.0.0',
      lifecycle: 'run',
      command,
      inspectUrl: '',
      packageDir: cwd,
    }

    const result = await runner.run(taggedScript, cwd)
    process.exit(result.exitCode ?? 0)
    return
  }

  console.log(chalk.yellow('⚠ Running natively without sandbox (use --sandbox to isolate)'))

  const envPath = process.env['PATH'] ?? ''
  const binPath = path.join(cwd, 'node_modules', '.bin')
  const env = { ...process.env, PATH: `${binPath}${path.delimiter}${envPath}` }

  const fullCmd = scriptArgs.length > 0 ? `${command} ${scriptArgs.join(' ')}` : command
  const proc = spawn(fullCmd, [], { stdio: 'inherit', shell: true, cwd, env })

  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => { process.exit(code ?? 0); resolve() })
    proc.on('error', reject)
  })
}

// ─── exec ─────────────────────────────────────────────────────────────────────

export async function execPackage(
  pkgSpec: string,
  execArgs: string[],
  flags: { cwd?: string }
): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()

  const atIdx = pkgSpec.lastIndexOf('@')
  const name = atIdx > 0 ? pkgSpec.slice(0, atIdx) : pkgSpec
  const versionRange = atIdx > 0 ? pkgSpec.slice(atIdx + 1) : 'latest'

  const rc = await loadRc(cwd)
  const globalConfig = await loadGlobalConfig()
  const resolver = new Resolver(rc.registries)

  const spinner = ora(`Resolving ${name}@${versionRange}...`).start()
  let exactVersion: string
  try {
    const packument = await resolver.fetchPackument(name)
    const resolved = resolver.selectVersion(packument, versionRange)
    if (!resolved) throw new Error(`No version matching "${versionRange}" for "${name}"`)
    exactVersion = resolved
  } catch (err) {
    spinner.stop()
    console.error(chalk.red(`✗ ${(err as Error).message}`))
    process.exit(1)
    return
  }
  spinner.stop()

  console.log()
  console.log(chalk.yellow(`⚠ About to download and execute ${chalk.bold(`${name}@${exactVersion}`)} — third-party code`))
  console.log(chalk.gray('  Runs in a Docker sandbox and is deleted after execution.'))
  console.log()

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let answer: string
  try {
    answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase()
  } finally {
    rl.close()
  }

  if (answer !== 'y' && answer !== 'yes') { console.log(chalk.gray('Aborted.')); return }

  const store = new CASStore(globalConfig.storeDir)
  const fetcher = new Fetcher(store, rc.registries)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-exec-'))

  try {
    const spinnerDl = ora(`Downloading ${name}@${exactVersion}...`).start()
    const fetchResult = await fetcher.fetchOne({ name, version: exactVersion })
    spinnerDl.stop()

    for (const file of fetchResult.files) {
      const destPath = path.join(tmpDir, file.relativePath)
      await fs.mkdir(path.dirname(destPath), { recursive: true })
      await store.link(file.hash, destPath)
    }

    const tmpPkgPath = path.join(tmpDir, 'package.json')
    let binCommand: string | undefined
    try {
      const tmpPkg = JSON.parse(await fs.readFile(tmpPkgPath, 'utf8')) as {
        bin?: string | Record<string, string>; name?: string
      }
      if (typeof tmpPkg.bin === 'string') {
        binCommand = tmpPkg.bin
      } else if (tmpPkg.bin && typeof tmpPkg.bin === 'object') {
        const binMap = tmpPkg.bin
        binCommand = binMap[name] ?? binMap[tmpPkg.name ?? ''] ?? Object.values(binMap)[0]
      }
    } catch {
      console.error(chalk.red('✗ Could not read package.json from downloaded package'))
      process.exit(1)
      return
    }

    if (!binCommand) {
      console.error(chalk.red(`✗ No binary entry point found in ${name}@${exactVersion}`))
      process.exit(1)
      return
    }

    // Path traversal guard: ensure binary resolves inside tmpDir
    const resolvedBin = path.resolve(tmpDir, binCommand)
    if (!resolvedBin.startsWith(tmpDir + path.sep) && resolvedBin !== tmpDir) {
      console.error(chalk.red('✗ Binary path escape detected — aborting'))
      process.exit(1)
      return
    }

    const argsStr = execArgs.length > 0 ? ' ' + execArgs.join(' ') : ''
    const runner = new SandboxRunner(new Dockerode(), rc, globalConfig.reportsDir)
    const taggedScript: TaggedScript = {
      name,
      version: exactVersion,
      lifecycle: 'run',
      command: `node ${resolvedBin}${argsStr}`,
      inspectUrl: '',
      packageDir: tmpDir,
    }

    const result = await runner.run(taggedScript, tmpDir)
    if (result.exitCode !== undefined && result.exitCode !== 0) process.exit(result.exitCode)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(packages: string[], flags: { cwd?: string; latest?: boolean }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const lockPath = path.join(cwd, 'sandboxpm.lock')

  if (!flags.latest) {
    // Delete lockfile to force fresh resolution within current ranges
    try { await fs.unlink(lockPath) } catch { /* ok */ }
    console.log(chalk.gray('Updating packages within their current ranges...'))
    await install({ cwd })
    return
  }

  const pkgPath = path.join(cwd, 'package.json')
  let pkgJson: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
  } catch {
    console.error(chalk.red('✗ No package.json found. Run `sandboxpm init` first.'))
    process.exit(1)
    return
  }

  const rc = await loadRc(cwd)
  const resolver = new Resolver(rc.registries)

  type DepField = 'dependencies' | 'devDependencies' | 'optionalDependencies'
  const allDeps: Array<{ name: string; range: string; field: DepField }> = []

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as DepField[]) {
    const deps = pkgJson[field]
    if (!deps) continue
    for (const [name, range] of Object.entries(deps)) {
      if (packages.length === 0 || packages.includes(name)) {
        allDeps.push({ name, range, field })
      }
    }
  }

  if (allDeps.length === 0) { console.log(chalk.yellow('No packages to update')); return }

  const spinner = ora('Checking latest versions...').start()
  let updated = 0

  for (const dep of allDeps) {
    try {
      const packument = await resolver.fetchPackument(dep.name)
      const distTags = packument['dist-tags']
      const latest = distTags['latest']
      if (!latest) continue

      const prefix = dep.range.match(/^([~^>=<]*)/)?.[1] ?? '^'
      const newRange = `${prefix}${latest}`

      const fieldObj = pkgJson[dep.field]
      if (!fieldObj) continue
      const currentRange = fieldObj[dep.name]
      if (currentRange !== undefined && currentRange !== newRange) {
        fieldObj[dep.name] = newRange
        updated++
        spinner.text = `${dep.name}: ${currentRange} → ${newRange}`
      }
    } catch { /* skip */ }
  }

  spinner.stop()

  if (updated === 0) { console.log(chalk.green('✓ All packages already at latest')); return }

  await fs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n')
  console.log(chalk.green(`✓ Updated ${updated} package${updated === 1 ? '' : 's'} in package.json`))

  try { await fs.unlink(lockPath) } catch { /* ok */ }
  await install({ cwd })
}

// ─── version (bump) ───────────────────────────────────────────────────────────

export async function bumpVersion(bump: string, flags: { cwd?: string; noGitTag?: boolean }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const pkgPath = path.join(cwd, 'package.json')

  let pkgJson: { version?: string; scripts?: Record<string, string> } & Record<string, unknown>
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
  } catch {
    console.error(chalk.red('✗ No package.json found. Run `sandboxpm init` first.'))
    process.exit(1)
    return
  }

  const currentVersion = typeof pkgJson['version'] === 'string' ? pkgJson['version'] : '0.0.0'
  const validBumps = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease']

  let newVersion: string | null
  if (validBumps.includes(bump)) {
    newVersion = semver.inc(currentVersion, bump as semver.ReleaseType)
  } else if (semver.valid(bump)) {
    newVersion = semver.clean(bump)
  } else {
    console.error(chalk.red(`✗ Invalid version bump: "${bump}"`))
    process.exit(1)
    return
  }

  if (!newVersion) {
    console.error(chalk.red(`✗ Could not compute new version from "${currentVersion}" + "${bump}"`))
    process.exit(1)
    return
  }

  if (pkgJson['scripts']?.['preversion']) await runScript('preversion', [], { cwd })

  pkgJson['version'] = newVersion
  await fs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n')
  console.log(chalk.green(`✓ ${currentVersion} → ${newVersion}`))

  if (pkgJson['scripts']?.['version']) await runScript('version', [], { cwd })

  if (!flags.noGitTag) {
    const tag = `v${newVersion}`
    const spawnSync = (cmd: string, args: string[]) =>
      new Promise<void>((resolve) => spawn(cmd, args, { cwd, stdio: 'inherit' }).on('close', () => resolve()))
    await spawnSync('git', ['add', 'package.json'])
    await spawnSync('git', ['commit', '-m', tag])
    await spawnSync('git', ['tag', tag])
    console.log(chalk.green(`✓ Created git tag ${tag}`))
  }

  if (pkgJson['scripts']?.['postversion']) await runScript('postversion', [], { cwd })
}

// ─── link / unlink ────────────────────────────────────────────────────────────

async function globalLinksDir(): Promise<string> {
  const globalConfig = await loadGlobalConfig()
  return path.join(path.dirname(globalConfig.storeDir), 'links')
}

export async function linkPackage(targetPath: string | undefined, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()

  if (targetPath === undefined) {
    // Register the current package as globally linkable
    const pkgJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { name?: string }
    const pkgName = pkgJson.name
    if (!pkgName) { console.error(chalk.red('✗ package.json missing "name" field')); process.exit(1); return }

    const linksDir = await globalLinksDir()
    await fs.mkdir(linksDir, { recursive: true })
    const linkPath = path.join(linksDir, pkgName.replace(/\//g, '+'))
    try { await fs.rm(linkPath, { force: true }) } catch { /* ok */ }
    await fs.symlink(cwd, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

    console.log(chalk.green(`✓ Registered ${pkgName} → ${cwd}`))
    console.log(chalk.gray(`  Run \`sandboxpm link ${pkgName}\` in another project to use it`))
    return
  }

  // Link a globally registered package or local path into node_modules
  console.log(chalk.yellow('⚠ Linked packages bypass the CAS store — file integrity is not verified.'))
  console.log(chalk.yellow('  Only link packages from sources you trust.\n'))

  const linksDir = await globalLinksDir()
  const registeredLink = path.join(linksDir, targetPath.replace(/\//g, '+'))

  let sourcePath: string
  try {
    await fs.access(registeredLink)
    sourcePath = await fs.realpath(registeredLink)
  } catch {
    sourcePath = path.resolve(cwd, targetPath)
    try { await fs.access(sourcePath) } catch {
      console.error(chalk.red(`✗ Package "${targetPath}" not found in global links or as local path`))
      process.exit(1)
      return
    }
  }

  const srcPkg = JSON.parse(await fs.readFile(path.join(sourcePath, 'package.json'), 'utf8')) as { name?: string }
  const pkgName = srcPkg.name ?? targetPath

  const nodeModules = path.join(cwd, 'node_modules')
  await fs.mkdir(nodeModules, { recursive: true })
  const destPath = path.join(nodeModules, pkgName)
  try { await fs.rm(destPath, { recursive: true, force: true }) } catch { /* ok */ }
  await fs.symlink(sourcePath, destPath, process.platform === 'win32' ? 'junction' : 'dir')

  console.log(chalk.green(`✓ Linked ${pkgName} → ${sourcePath}`))
}

export async function unlinkPackage(pkgName: string | undefined, flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()

  if (pkgName === undefined) {
    const pkgJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { name?: string }
    const name = pkgJson.name
    if (!name) { console.error(chalk.red('✗ package.json missing "name" field')); process.exit(1); return }

    const linksDir = await globalLinksDir()
    const linkPath = path.join(linksDir, name.replace(/\//g, '+'))
    try { await fs.rm(linkPath, { force: true }); console.log(chalk.green(`✓ Unregistered ${name}`)) }
    catch { console.log(chalk.gray(`${name} was not globally registered`)) }
    return
  }

  const destPath = path.join(cwd, 'node_modules', pkgName)
  try { await fs.rm(destPath, { recursive: true, force: true }); console.log(chalk.green(`✓ Removed link to ${pkgName}`)) }
  catch { console.log(chalk.gray(`${pkgName} was not linked`)) }
}

// ─── pack ─────────────────────────────────────────────────────────────────────

export async function pack(flags: { cwd?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const pkgPath = path.join(cwd, 'package.json')

  let pkgJson: { name?: string; version?: string; private?: boolean }
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
  } catch {
    console.error(chalk.red('✗ No package.json found. Run `sandboxpm init` first.'))
    process.exit(1)
    return
  }

  if (pkgJson.private) {
    console.error(chalk.red('✗ Package is marked private — aborting pack'))
    process.exit(1)
    return
  }

  // Scan for potentially sensitive files
  const SENSITIVE = /^(\.env(\..+)?|id_rsa(\.pub)?|.*\.pem|.*\.key|.*\.secret|credentials(\.json)?)$/i
  const allFiles = await fs.readdir(cwd, { recursive: true }) as string[]
  const suspicious = allFiles.filter(f => SENSITIVE.test(path.basename(f)))

  if (suspicious.length > 0) {
    console.log(chalk.yellow('⚠ Potentially sensitive files in this directory:'))
    for (const f of suspicious) console.log(chalk.red(`  ${f}`))
    console.log()
  }

  const spinner = ora('Creating tarball...').start()
  const npmPack = spawn('npm', ['pack', '--pack-destination', cwd], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })

  let out = ''
  if (npmPack.stdout) npmPack.stdout.on('data', (d: Buffer) => { out += d.toString() })

  const exitCode = await new Promise<number>((resolve) => npmPack.on('close', (c) => resolve(c ?? 0)))
  spinner.stop()

  if (exitCode !== 0) { console.error(chalk.red('✗ Pack failed')); process.exit(1); return }

  console.log(chalk.green(`✓ Created ${out.trim() || `${pkgJson.name ?? 'package'}-${pkgJson.version ?? '0.0.0'}.tgz`}`))
}

// ─── publish ──────────────────────────────────────────────────────────────────

export async function publish(flags: { cwd?: string; access?: string; registry?: string }): Promise<void> {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd()
  const pkgPath = path.join(cwd, 'package.json')

  let pkgJson: { name?: string; private?: boolean }
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
  } catch {
    console.error(chalk.red('✗ No package.json found.')); process.exit(1); return
  }

  if (pkgJson.private) {
    console.error(chalk.red('✗ Package is marked private — aborting publish')); process.exit(1); return
  }

  const name = pkgJson.name ?? ''
  if (!name.startsWith('@') && flags.access !== 'public') {
    console.error(chalk.red('✗ Unscoped packages require --access public to prevent accidental publish'))
    process.exit(1); return
  }

  // Check for tokens in .sandboxpmrc (security warning)
  const rc = await loadRc(cwd)
  const hasRcToken = rc.registries.some(r => r.token)
  if (hasRcToken) {
    console.log(chalk.yellow('⚠ registry.token found in .sandboxpmrc — this file may be committed to git'))
    console.log(chalk.gray('  Use `sandboxpm login` to store tokens securely in ~/.sandboxpm/auth.json\n'))
  }

  // Scan for sensitive files
  const SENSITIVE = /^(\.env(\..+)?|id_rsa(\.pub)?|.*\.pem|.*\.key|.*\.secret|credentials(\.json)?)$/i
  const allFiles = await fs.readdir(cwd, { recursive: true }) as string[]
  const suspicious = allFiles.filter(f => SENSITIVE.test(path.basename(f)))

  if (suspicious.length > 0) {
    console.log(chalk.yellow('⚠ Potentially sensitive files detected:'))
    for (const f of suspicious) console.log(chalk.red(`  ${f}`))
    console.log()
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let answer: string
    try { answer = (await rl.question('Continue anyway? [y/N] ')).trim().toLowerCase() }
    finally { rl.close() }
    if (answer !== 'y' && answer !== 'yes') { console.log(chalk.gray('Aborted.')); return }
  }

  const npmArgs = ['publish']
  if (flags.access) npmArgs.push('--access', flags.access)
  if (flags.registry) npmArgs.push('--registry', flags.registry)

  const proc = spawn('npm', npmArgs, { cwd, stdio: 'inherit' })
  const code = await new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? 0)))
  process.exit(code)
}

// ─── login / logout ───────────────────────────────────────────────────────────

async function loadAuth(): Promise<Record<string, string>> {
  const authFile = path.join(os.homedir(), '.sandboxpm', 'auth.json')
  try { return JSON.parse(await fs.readFile(authFile, 'utf8')) as Record<string, string> }
  catch { return {} }
}

async function saveAuth(auth: Record<string, string>): Promise<void> {
  const authFile = path.join(os.homedir(), '.sandboxpm', 'auth.json')
  await fs.mkdir(path.dirname(authFile), { recursive: true })
  await fs.writeFile(authFile, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
}

export async function login(flags: { registry?: string }): Promise<void> {
  const registryUrl = (flags.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let token: string
  try {
    console.log(chalk.gray(`Logging in to ${registryUrl}`))
    token = (await rl.question('Access token: ')).trim()
  } finally {
    rl.close()
  }

  if (!token) { console.error(chalk.red('✗ Token cannot be empty')); process.exit(1); return }

  const auth = await loadAuth()
  auth[registryUrl] = token
  await saveAuth(auth)

  console.log(chalk.green(`✓ Logged in to ${registryUrl}`))
  console.log(chalk.gray('  Token saved to ~/.sandboxpm/auth.json (chmod 600)'))
}

export async function logout(flags: { registry?: string }): Promise<void> {
  const registryUrl = (flags.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const auth = await loadAuth()

  if (Object.prototype.hasOwnProperty.call(auth, registryUrl)) {
    delete auth[registryUrl]
    await saveAuth(auth)
    console.log(chalk.green(`✓ Logged out from ${registryUrl}`))
  } else {
    console.log(chalk.gray(`Not logged in to ${registryUrl}`))
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
  .description('Initialize a new project (package.json + .sandboxpmrc)')
  .option('-y, --yes', 'skip prompts and use defaults')
  .action(async (opts: { yes?: boolean }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await init({ ...(cwd ? { cwd } : {}), ...(opts.yes ? { yes: true } : {}) })
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

const trust = program.command('trust').description('Manage packages exempted from typosquat/risk checks')
trust
  .command('add <package>')
  .description('Exempt a package from typosquat/low-trust risk checks')
  .action(async (pkg: string) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await trustAdd(pkg, cwd ? { cwd } : {})
  })
trust
  .command('remove <package>')
  .description('Remove a package from the trusted list')
  .action(async (pkg: string) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await trustRemove(pkg, cwd ? { cwd } : {})
  })

const block = program.command('block').description('Manage packages that always abort resolution')
block
  .command('add <package>')
  .description('Always abort install if this package name appears in the resolved tree')
  .action(async (pkg: string) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await blockAdd(pkg, cwd ? { cwd } : {})
  })
block
  .command('remove <package>')
  .description('Remove a package from the blocklist')
  .action(async (pkg: string) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await blockRemove(pkg, cwd ? { cwd } : {})
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

program
  .command('ls')
  .alias('list')
  .description('List installed packages')
  .option('--depth <n>', 'Depth of the dependency tree to show (default: 0)', parseInt)
  .option('--json', 'Output as JSON')
  .action(async (opts: { depth?: number; json?: boolean }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await listPackages({ ...(cwd ? { cwd } : {}), ...(opts.depth !== undefined ? { depth: opts.depth } : {}), ...(opts.json ? { json: true } : {}) })
  })

program
  .command('why <package>')
  .description('Explain why a package is installed')
  .action(async (pkg: string) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await why(pkg, cwd ? { cwd } : {})
  })

program
  .command('outdated')
  .description('Check for outdated packages')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await outdated({ ...(cwd ? { cwd } : {}), ...(opts.json ? { json: true } : {}) })
  })

program
  .command('info <package>')
  .alias('view')
  .description('Show package metadata from the registry')
  .option('--json', 'Output as JSON')
  .action(async (pkg: string, opts: { json?: boolean }) => {
    await info(pkg, opts.json ? { json: true } : {})
  })

program
  .command('search <query>')
  .description('Search packages in the registry')
  .option('--json', 'Output as JSON')
  .action(async (query: string, opts: { json?: boolean }) => {
    await search(query, opts.json ? { json: true } : {})
  })

program
  .command('run <script> [args...]')
  .description('Run a package.json script (native by default, use --sandbox to isolate)')
  .option('--sandbox', 'Run in Docker sandbox')
  .action(async (scriptName: string, args: string[], opts: { sandbox?: boolean }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await runScript(scriptName, args ?? [], { ...(cwd ? { cwd } : {}), ...(opts.sandbox ? { sandbox: true } : {}) })
  })

for (const name of ['test', 'start', 'stop'] as const) {
  program
    .command(`${name} [args...]`)
    .description(`Alias for \`sandboxpm run ${name}\``)
    .option('--sandbox', 'Run in Docker sandbox')
    .allowUnknownOption()
    .action(async (args: string[], opts: { sandbox?: boolean }) => {
      const { cwd } = program.opts<{ cwd?: string }>()
      await runScript(name, args ?? [], { ...(cwd ? { cwd } : {}), ...(opts.sandbox ? { sandbox: true } : {}) })
    })
}

program
  .command('exec <package> [args...]')
  .description('Download and execute a package binary in a Docker sandbox (always sandboxed)')
  .action(async (pkgSpec: string, args: string[]) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await execPackage(pkgSpec, args ?? [], cwd ? { cwd } : {})
  })

program
  .command('update [packages...]')
  .alias('up')
  .description('Update packages to latest compatible versions')
  .option('--latest', 'Update to absolute latest (may change major version)')
  .action(async (packages: string[], opts: { latest?: boolean }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await update(packages ?? [], { ...(cwd ? { cwd } : {}), ...(opts.latest ? { latest: true } : {}) })
  })

program
  .command('version <bump>')
  .description('Bump package version (major|minor|patch|prerelease or exact)')
  .option('--no-git-tag', 'Skip creating a git commit and tag')
  .action(async (bump: string, opts: { gitTag?: boolean }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await bumpVersion(bump, { ...(cwd ? { cwd } : {}), ...(opts.gitTag === false ? { noGitTag: true } : {}) })
  })

const linkCmd = program.command('link').description('Link a local package for development')
linkCmd
  .command('[path]')
  .description('Link a local package into node_modules (or register current package globally)')
  .action(async (targetPath: string | undefined) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await linkPackage(targetPath, cwd ? { cwd } : {})
  })

const unlinkCmd = program.command('unlink').description('Remove a linked package')
unlinkCmd
  .command('[name]')
  .description('Remove a linked package from node_modules (or unregister current package globally)')
  .action(async (pkgName: string | undefined) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await unlinkPackage(pkgName, cwd ? { cwd } : {})
  })

program
  .command('pack')
  .description('Create a tarball of the current package')
  .action(async () => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await pack(cwd ? { cwd } : {})
  })

program
  .command('publish')
  .description('Publish the current package to the registry')
  .option('--access <level>', 'Access level: public or restricted')
  .option('--registry <url>', 'Registry URL')
  .action(async (opts: { access?: string; registry?: string }) => {
    const { cwd } = program.opts<{ cwd?: string }>()
    await publish({ ...(cwd ? { cwd } : {}), ...(opts.access ? { access: opts.access } : {}), ...(opts.registry ? { registry: opts.registry } : {}) })
  })

program
  .command('login')
  .description('Save a registry access token to ~/.sandboxpm/auth.json')
  .option('--registry <url>', 'Registry URL (default: https://registry.npmjs.org)')
  .action(async (opts: { registry?: string }) => {
    await login(opts.registry ? { registry: opts.registry } : {})
  })

program
  .command('logout')
  .description('Remove a saved registry token')
  .option('--registry <url>', 'Registry URL (default: https://registry.npmjs.org)')
  .action(async (opts: { registry?: string }) => {
    await logout(opts.registry ? { registry: opts.registry } : {})
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

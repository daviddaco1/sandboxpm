/**
 * @sandboxpm/scripts
 *
 * Interactive script approval prompt + Docker sandbox runner.
 * No script ever runs without explicit developer consent.
 */

import * as fs from 'fs/promises'
import type { Dirent } from 'node:fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import inquirer from 'inquirer'
import chalk from 'chalk'
import Dockerode from 'dockerode'
import type { PackageScript } from '@sandboxpm/fetcher'
import type { SandboxpmRc } from '@sandboxpm/config'
import { parseStraceLog } from './trace-parser.js'

export type ScriptDecision =
  | 'run'
  | 'skip'
  | 'whitelisted'
  | 'blacklisted'

export interface ScriptRunResult {
  packageId: string
  lifecycle: string
  decision: ScriptDecision
  exitCode?: number
  durationMs?: number
  nativeRun?: boolean
  sandboxReport?: SandboxReport
}

export interface SandboxReport {
  networkConnections: string[]
  blockedConnections: string[]
  filesWritten: string[]
  unexpectedActivity: string[]
  status: 'clean' | 'warned' | 'blocked'
  /** true when populated from a real strace trace; undefined = today's cosmetic stub (Windows, or auditSyscalls off) */
  audited?: boolean
}

/** A PackageScript enriched with the identity of its owner package. */
export interface TaggedScript extends PackageScript {
  name: string        // package name
  version: string     // package exact version
  packageDir: string  // absolute path to the package inside node_modules after linking
}

const SEPARATOR = '─'.repeat(50)
const SANDBOX_IMAGE = 'sandboxpm-sandbox:latest'
const SANDBOX_IMAGE_WIN = 'sandboxpm-sandbox-win:latest'
const SANDBOX_NETWORK = 'sandboxpm-net'

// import.meta.url → dist/index.js; ../assets/ → assets/ (bundled with the package)
const ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url))
const ASSETS_DIR_WIN = fileURLToPath(new URL('../assets/windows', import.meta.url))
const SECCOMP_PATH = fileURLToPath(new URL('../assets/seccomp.json', import.meta.url))
// Only used when sandbox.auditSyscalls is on — allows ptrace so strace can trace
// the script it launches. Never the default profile.
const SECCOMP_AUDIT_PATH = fileURLToPath(new URL('../assets/seccomp-audit.json', import.meta.url))
const TRACE_CONTAINER_DIR = '/sandbox/trace'
const TRACE_CONTAINER_FILE = `${TRACE_CONTAINER_DIR}/strace.log`

// Packages seeded by the Linux sandbox entrypoint into the writable tmpfs.
// node-gyp writes .target.mk files back into them, so they need write access;
// they are excluded from the read-only per-dep bind mounts and handled separately.
const ENTRYPOINT_SEEDED = new Set(['node-addon-api', 'nan'])

export class ScriptPrompt {
  private readonly rc: SandboxpmRc
  private readonly runner: SandboxRunner | null

  constructor(rc: SandboxpmRc, runner: SandboxRunner | null = null) {
    this.rc = rc
    this.runner = runner
  }

  async promptAll(scripts: TaggedScript[]): Promise<ScriptRunResult[]> {
    if (scripts.length === 0) return []

    const { toPrompt, autoRun, autoSkip, toAbort } = this._partitionScripts(scripts)
    const results: ScriptRunResult[] = []

    if (toAbort.length > 0) {
      const names = toAbort.map(s => `${s.name}@${s.version}`).join(', ')
      throw new Error(
        `Install aborted: ${toAbort.length} unreviewed install script(s) detected ` +
        `and policies.onWarn is 'abort'. Packages: ${names}`
      )
    }

    for (const script of autoSkip) {
      const decision: ScriptDecision = this.rc.blacklist.includes(script.name) ? 'blacklisted' : 'skip'
      results.push({
        packageId: `${script.name}@${script.version}`,
        lifecycle: script.lifecycle,
        decision,
      })
    }

    try {
      for (const script of autoRun) {
        if (this.runner) {
          results.push(await this._runWithFallbacks(this.runner, script))
        } else {
          results.push({
            packageId: `${script.name}@${script.version}`,
            lifecycle: script.lifecycle,
            decision: 'whitelisted',
          })
        }
      }

      if (toPrompt.length > 0) {
        console.log(chalk.yellow(`\n⚠  ${toPrompt.length} package(s) have install scripts\n`))
      }

      for (const script of toPrompt) {
        const decision = await this.promptOne(script)
        const pkgId = `${script.name}@${script.version}`

        if (decision === 'run' || decision === 'whitelisted') {
          if (decision === 'whitelisted') {
            this.rc.whitelist.push(script.name)
          }
          if (this.runner) {
            results.push(await this._runWithFallbacks(this.runner, script))
          } else {
            results.push({ packageId: pkgId, lifecycle: script.lifecycle, decision })
          }
        } else {
          if (decision === 'blacklisted') {
            this.rc.blacklist.push(script.name)
          }
          results.push({ packageId: pkgId, lifecycle: script.lifecycle, decision: 'skip' })
        }
      }
    } finally {
      // If a Windows-containers rebuild switched Docker Desktop's engine mid-install,
      // always put it back the way we found it, even if a later script throws.
      await this.runner?.restoreDockerEngine()
    }

    return results
  }

  // Runs a script and, if it fails in a way that suggests a platform mismatch
  // (sandbox couldn't start, or it compiled a Linux binary incompatible with a
  // Windows host), offers escalating fallbacks: a Windows-containers rebuild
  // (still sandboxed) first, then a native (unsandboxed) run as a last resort.
  private async _runWithFallbacks(runner: SandboxRunner, script: TaggedScript): Promise<ScriptRunResult> {
    let result = await runner.run(script, script.packageDir)

    if (await runner.isNativeFallbackCandidate(result, script.packageDir)) {
      if (await runner.canOfferWindowsContainerRebuild()) {
        if (await this._promptWindowsContainerSwitch(script)) {
          result = await runner.runInWindowsContainer(script, script.packageDir)
        }
      }

      if (await runner.isNativeFallbackCandidate(result, script.packageDir)) {
        if (await this._promptNativeFallback(script, result)) {
          result = await runner.runNative(script, script.packageDir)
        }
      }
    }

    return result
  }

  async promptOne(script: TaggedScript): Promise<ScriptDecision> {
    const pkgId = `${script.name}@${script.version}`

    console.log(chalk.gray(`\n${SEPARATOR}`))
    console.log(chalk.yellow(`⚠  ${chalk.bold(pkgId)}`))
    console.log(chalk.gray(SEPARATOR))
    console.log(`  ${chalk.gray('Type:')}    ${script.lifecycle}`)
    console.log(`  ${chalk.gray('Script:')}  ${script.command}`)
    console.log(`  ${chalk.gray('Inspect:')} ${script.inspectUrl}`)
    console.log()

    while (true) {
      const { choice } = await inquirer.prompt<{ choice: string }>([{
        type: 'list',
        name: 'choice',
        message: 'Run this script?',
        default: 'skip',
        choices: [
          { name: 'N — skip (default)', value: 'skip' },
          { name: 'y — run in sandbox', value: 'run' },
          { name: 'inspect — open in browser, then re-ask', value: 'inspect' },
          { name: 'always — whitelist and run', value: 'whitelisted' },
          { name: 'never — blacklist and skip', value: 'blacklisted' },
        ],
      }])

      if (choice === 'inspect') {
        await this.openInspect(script.inspectUrl)
        continue
      }

      return choice as ScriptDecision
    }
  }

  async openInspect(url: string): Promise<void> {
    const { default: open } = await import('open')
    await open(url)
  }

  // Only asked once per install: SandboxRunner stays switched to Windows containers
  // for the rest of the run (see runInWindowsContainer/restoreDockerEngine), so this
  // prompt won't fire again for later packages that hit the same fallback.
  private async _promptWindowsContainerSwitch(script: TaggedScript): Promise<boolean> {
    const pkgId = `${script.name}@${script.version}`

    console.log(chalk.gray(`\n${SEPARATOR}`))
    console.log(chalk.yellow(`  ⚠  ${pkgId} ${script.lifecycle}: needs a Windows-native rebuild.`))
    console.log(chalk.yellow('  sandboxpm can switch Docker Desktop to Windows containers and'))
    console.log(chalk.yellow('  rebuild there — still fully sandboxed, just a different image.'))
    console.log(chalk.yellow('  This stops any Linux containers you have running elsewhere, and'))
    console.log(chalk.yellow('  the engine switch can take a minute or two. sandboxpm switches'))
    console.log(chalk.yellow('  Docker back to Linux containers automatically when the install finishes.'))
    console.log(chalk.gray(SEPARATOR))

    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([{
      type: 'confirm',
      name: 'confirm',
      message: `Switch Docker Desktop to Windows containers and rebuild ${pkgId} there?`,
      default: false,
    }])

    return confirm
  }

  // Intentionally re-confirms on every call — there is no whitelist/cache for
  // native-fallback consent, so a package needing this fallback across multiple
  // installs is prompted (twice) each time. This is by design, not a gap.
  private async _promptNativeFallback(
    script: TaggedScript,
    result: ScriptRunResult,
  ): Promise<boolean> {
    const pkgId = `${script.name}@${script.version}`
    const isSandboxError = result.sandboxReport?.status === 'blocked'
    const reason = isSandboxError
      ? 'blocked by sandbox (container setup error)'
      : 'compiled a Linux binary incompatible with this Windows host'

    console.log(chalk.gray(`\n${SEPARATOR}`))
    console.log(chalk.yellow(`  ⚠  ${pkgId} ${script.lifecycle}: ${reason}.`))
    console.log(chalk.yellow('  Running natively gives the script unrestricted access to your system.'))
    console.log(chalk.gray(SEPARATOR))

    const { firstConfirm } = await inquirer.prompt<{ firstConfirm: boolean }>([{
      type: 'confirm',
      name: 'firstConfirm',
      message: `Run ${pkgId} ${script.lifecycle} natively (without sandbox)?`,
      default: false,
    }])

    if (!firstConfirm) return false

    // Second confirmation with explicit security warning
    const red = chalk.bold.red
    console.log(red('\n  ╔══════════════════════════════════════════════════╗'))
    console.log(red('  ║  SECURITY WARNING — RUNNING WITHOUT ISOLATION   ║'))
    console.log(red('  ╠══════════════════════════════════════════════════╣'))
    console.log(red('  ║  If you do not know what this script does, it    ║'))
    console.log(red('  ║  could contain MALICIOUS CODE that:              ║'))
    console.log(red('  ║    • reads or exfiltrates your files             ║'))
    console.log(red('  ║    • installs backdoors or malware               ║'))
    console.log(red('  ║    • modifies your system configuration          ║'))
    console.log(red('  ╚══════════════════════════════════════════════════╝\n'))

    const { secondConfirm } = await inquirer.prompt<{ secondConfirm: boolean }>([{
      type: 'confirm',
      name: 'secondConfirm',
      message: red(`I understand the risk. Run ${pkgId} natively anyway?`),
      default: false,
    }])

    return secondConfirm
  }

  private _partitionScripts(scripts: TaggedScript[]): {
    toPrompt: TaggedScript[]
    autoRun: TaggedScript[]
    autoSkip: TaggedScript[]
    toAbort: TaggedScript[]
  } {
    const toPrompt: TaggedScript[] = []
    const autoRun: TaggedScript[] = []
    const autoSkip: TaggedScript[] = []
    const toAbort: TaggedScript[] = []
    const { onWarn, onBlock } = this.rc.policies

    for (const script of scripts) {
      if (this.rc.whitelist.includes(script.name)) {
        autoRun.push(script)
      } else if (this.rc.blacklist.includes(script.name)) {
        if (onBlock === 'prompt') {
          toPrompt.push(script)
        } else {
          autoSkip.push(script)  // onBlock: 'abort' (default)
        }
      } else {
        if (onWarn === 'continue') {
          autoSkip.push(script)
        } else if (onWarn === 'abort') {
          toAbort.push(script)
        } else {
          toPrompt.push(script)  // onWarn: 'prompt' (default)
        }
      }
    }
    return { toPrompt, autoRun, autoSkip, toAbort }
  }
}

export class SandboxRunner {
  private readonly docker: Dockerode
  private readonly rc: SandboxpmRc
  private readonly reportsDir: string | undefined
  private _isWindowsDaemonResult: boolean | undefined
  // True once runInWindowsContainer has switched Docker Desktop's engine for this
  // install — later fallback calls reuse the already-switched daemon instead of
  // switching (and prompting) again for every package.
  private _switchedToWindows = false
  // True once a windows-engine switch attempt has definitively failed this install —
  // stops canOfferWindowsContainerRebuild from re-prompting for every later package
  // when we already know the switch doesn't work on this machine.
  private _windowsContainersUnavailable = false

  constructor(docker: Dockerode, rc: SandboxpmRc, reportsDir?: string) {
    this.docker = docker
    this.rc = rc
    this.reportsDir = reportsDir
  }

  async run(
    script: TaggedScript,
    packageDir: string,
  ): Promise<ScriptRunResult> {
    const isWin = await this._isWindowsDaemon()
    await this.ensureNetwork(isWin)
    await this._buildImageIfNeeded(isWin)

    const pkgId = `${script.name}@${script.version}`

    // Container path roots differ between Linux (Alpine) and Windows containers.
    const containerPkg = isWin ? 'C:/sandbox/package' : '/sandbox/package'
    const containerDepsBase = isWin ? 'C:/sandbox/deps' : '/sandbox/deps'

    // Build nested bind mounts from the virtual-store dep tree.  Each dep and its
    // sub-deps are mounted at /sandbox/deps/{name}/node_modules/{subdep}, preserving
    // pnpm-style version isolation so incompatible versions of the same package don't
    // conflict via NODE_PATH.  NODE_PATH=/sandbox/deps covers direct deps only.
    const pkgDepsDir = packageDir ? path.dirname(packageDir) : ''
    const pkgBaseName = packageDir ? path.basename(packageDir) : ''

    // On Windows containers node-addon-api/nan are globally installed and found
    // via NODE_PATH; on Linux the entrypoint seeds them into the writable tmpfs.
    const skipDeps = isWin ? new Set<string>() : ENTRYPOINT_SEEDED

    const depBinds = pkgDepsDir && isWin
      ? await this._resolveDepBindsNested(pkgDepsDir, pkgBaseName, skipDeps, containerDepsBase, new Set<string>(), 0)
      : []
    const depScopes = pkgDepsDir && !isWin
      ? await this._buildDepScopesLinux(pkgDepsDir, pkgBaseName, skipDeps)
      : { scopeBinds: [], scopeTmpfs: [], links: [] }

    // Real syscall auditing is Linux-only — Windows containers have no strace equivalent.
    const auditSyscalls = !isWin && this.rc.sandbox.auditSyscalls
    const traceDir = auditSyscalls
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-trace-'))
      : undefined

    const binds = [
      ...(packageDir ? [`${packageDir}:${containerPkg}:rw`] : []),
      ...depBinds,
      ...depScopes.scopeBinds,
      ...(traceDir ? [`${traceDir}:${TRACE_CONTAINER_DIR}:rw`] : []),
    ]

    const baseEnv = (this.rc.envPassthrough ?? [])
      .filter(v => process.env[v] !== undefined)
      .map(v => `${v}=${process.env[v] ?? ''}`)

    const createOpts = isWin
      ? this._buildWindowsOpts(script, binds, baseEnv, containerPkg, containerDepsBase)
      : await this._buildLinuxOpts(script, binds, baseEnv, containerDepsBase, auditSyscalls, depScopes.scopeTmpfs, depScopes.links)

    const startMs = Date.now()
    let result: ScriptRunResult

    try {
      const container = await this.docker.createContainer(createOpts)
      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      container.modem.demuxStream(stream, process.stdout, process.stderr)
      await container.start()
      const data = await container.wait()
      const exitCode = data.StatusCode ?? 0
      const durationMs = Date.now() - startMs

      result = {
        packageId: pkgId,
        lifecycle: script.lifecycle,
        decision: 'run',
        exitCode,
        durationMs,
        sandboxReport: await this._buildSandboxReport(traceDir, containerPkg),
      }
    } catch (err) {
      result = {
        packageId: pkgId,
        lifecycle: script.lifecycle,
        decision: 'run',
        exitCode: 1,
        durationMs: Date.now() - startMs,
        sandboxReport: {
          networkConnections: [],
          blockedConnections: [],
          filesWritten: [],
          unexpectedActivity: [(err as Error).message],
          status: 'blocked',
        },
      }
    } finally {
      if (traceDir) await fs.rm(traceDir, { recursive: true, force: true }).catch(() => {})
    }

    if (this.reportsDir !== undefined) {
      try {
        const filename = `${pkgId.replace(/\//g, '-')}-${Date.now()}.json`
        await fs.mkdir(this.reportsDir, { recursive: true })
        await fs.writeFile(
          path.join(this.reportsDir, filename),
          JSON.stringify(result, null, 2),
        )
      } catch {
        // Non-fatal — don't let report I/O failures break the install
      }
    }

    return result
  }

  async ensureNetwork(isWin = false): Promise<void> {
    // Windows containers use NAT networking; skip custom Linux bridge setup
    if (isWin) return
    // 'none' mode skips the bridge entirely — container uses NetworkMode:'none'
    if (this.rc.sandbox.networkMode === 'none') return

    try {
      const networks = await this.docker.listNetworks({ filters: { name: [SANDBOX_NETWORK] } })
      if (networks.length === 0) {
        // 'isolated' → Internal: true (no external egress at Docker level)
        // 'restricted' → Internal: false (host iptables rules control egress)
        const internal = this.rc.sandbox.networkMode === 'isolated'
        await this.docker.createNetwork({
          Name: SANDBOX_NETWORK,
          Driver: 'bridge',
          EnableIPv6: false,
          Internal: internal,
        })
      }
    } catch {
      // Non-fatal — Docker may not be available in all environments
    }
  }

  private _buildWindowsOpts(
    script: TaggedScript,
    binds: string[],
    baseEnv: string[],
    containerPkg: string,
    containerDepsBase: string,
  ): Dockerode.ContainerCreateOptions {
    // C:/npm/node_modules is the global npm prefix set in the Windows Dockerfile.
    const env = [
      `NODE_PATH=C:/npm/node_modules;${containerDepsBase}`,
      ...baseEnv,
    ]
    return {
      Image: SANDBOX_IMAGE_WIN,
      Entrypoint: [],  // Windows image has no entrypoint; run cmd directly
      Cmd: ['cmd', '/S', '/C', script.command],
      WorkingDir: containerPkg,
      Env: env,
      HostConfig: {
        AutoRemove: true,
        // Windows containers don't support seccomp/CapDrop/ReadonlyRootfs/PidsLimit —
        // confirmed live (Docker rejects PidsLimit with "Windows does not support
        // PidsLimit", HTTP 400, before the container even starts). Hyper-V isolation
        // provides the containment boundary here instead.
        Isolation: 'hyperv',
        Memory: 512 * 1024 * 1024,
        Binds: binds,
        ...(this.rc.sandbox.networkMode === 'none' ? { NetworkMode: 'none' } : {}),
      },
      AttachStdout: true,
      AttachStderr: true,
    }
  }

  private async _buildLinuxOpts(
    script: TaggedScript,
    binds: string[],
    baseEnv: string[],
    containerDepsBase: string,
    auditSyscalls: boolean,
    scopeTmpfsDirs: string[] = [],
    links: string[] = [],
  ): Promise<Dockerode.ContainerCreateOptions> {
    // Docker's SecurityOpt requires the seccomp JSON inline, not a host file path.
    // A Windows path (D:\...) would be rejected by the Docker daemon running in its Linux VM.
    const seccompJson = await fs.readFile(auditSyscalls ? SECCOMP_AUDIT_PATH : SECCOMP_PATH, 'utf8')
    const env = [
      'PATH=/usr/local/bin:/usr/bin:/bin',
      `NODE_PATH=${containerDepsBase}`,
      ...baseEnv,
      // sandbox-entrypoint.sh reads this before exec'ing the script — see
      // _buildDepScopesLinux for why the dep tree is wired up via symlinks
      // instead of nested bind mounts.
      ...(links.length > 0 ? [`SANDBOXPM_LINKS=${links.join('\n')}`] : []),
    ]
    // -s 0: don't dump buffer contents (keeps the log bounded on I/O-heavy installs)
    // -e trace=network,file: only the syscall classes the parser understands
    // -f: follow forks (node-gyp/python/cc subprocesses)
    const cmd = auditSyscalls
      ? ['/bin/sh', '-c', `strace -f -tt -s 0 -e trace=network,file -o ${TRACE_CONTAINER_FILE} -- ${script.command}`]
      : ['/bin/sh', '-c', script.command]
    // Each dep gets its own writable tmpfs "scope" dir so entrypoint can symlink
    // children into it without ever writing inside a `:ro` bind (see _buildDepScopesLinux).
    const scopeTmpfs = Object.fromEntries(
      scopeTmpfsDirs.map(dir => [dir, 'rw,size=1m,uid=1001,gid=1001'])
    )
    return {
      Image: SANDBOX_IMAGE,
      Cmd: cmd,
      WorkingDir: '/sandbox/package',
      Env: env,
      HostConfig: {
        AutoRemove: true,
        ReadonlyRootfs: true,
        Tmpfs: {
          '/tmp': 'rw,size=256m,uid=1001,gid=1001',
          '/home/sandbox': 'rw,size=128m,uid=1001,gid=1001',
          '/sandbox/package/node_modules': 'rw,size=512m,uid=1001,gid=1001',
          '/sandbox/deps': 'rw,size=4m,uid=1001,gid=1001',
          ...scopeTmpfs,
        },
        NetworkMode: this.rc.sandbox.networkMode === 'none' ? 'none' : SANDBOX_NETWORK,
        CapDrop: ['ALL'],
        // CAP_SYS_PTRACE is additive on top of CapDrop:['ALL'] and only granted when
        // auditing is on. It only lets strace self-trace the process tree it launched
        // inside this container's private PID namespace — it cannot reach the host or
        // other containers, so it doesn't widen the sandbox's actual blast radius.
        ...(auditSyscalls ? { CapAdd: ['SYS_PTRACE'] } : {}),
        SecurityOpt: [
          'no-new-privileges',
          `seccomp=${seccompJson}`,
        ],
        Memory: 512 * 1024 * 1024,
        PidsLimit: 100,
        Binds: binds,
      },
      AttachStdout: true,
      AttachStderr: true,
    }
  }

  // Builds the real SandboxReport from a completed strace trace, or falls back to
  // the cosmetic "clean" stub when auditing wasn't on (traceDir undefined) or the
  // trace couldn't be read (e.g. strace itself crashed) — never fail the install
  // over audit plumbing.
  private async _buildSandboxReport(traceDir: string | undefined, containerPkg: string): Promise<SandboxReport> {
    if (!traceDir) {
      return {
        networkConnections: [],
        blockedConnections: [],
        filesWritten: [],
        unexpectedActivity: [],
        status: 'clean',
      }
    }

    try {
      const log = await fs.readFile(path.join(traceDir, 'strace.log'), 'utf8')
      return parseStraceLog(log, { packageDir: containerPkg })
    } catch {
      return {
        networkConnections: [],
        blockedConnections: [],
        filesWritten: [],
        unexpectedActivity: ['syscall trace capture failed — report is unaudited'],
        status: 'clean',
      }
    }
  }

  private async _buildImageIfNeeded(isWin: boolean): Promise<void> {
    const image = isWin ? SANDBOX_IMAGE_WIN : SANDBOX_IMAGE
    const assetsDir = isWin ? ASSETS_DIR_WIN : ASSETS_DIR

    try {
      await this.docker.getImage(image).inspect()
      return  // image already present locally
    } catch { /* not found → build it */ }

    // Build from bundled Dockerfile — must succeed; a failed build means scripts
    // would run without the hardened sandbox image, which is unacceptable.
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile('docker', ['build', '-t', image, assetsDir], (err) => {
        if (err != null) {
          reject(new Error(
            `Cannot build sandboxpm sandbox image ${image}: ${(err as Error).message}. ` +
            'Make sure Docker is running and accessible, then retry.'
          ))
        } else {
          resolve()
        }
      })
    })
  }

  // Recursively builds nested bind mounts that mirror the virtual-store dep tree.
  // Windows-only (see _buildDepScopesLinux for why Linux needs a different approach):
  // Windows containers don't set ReadonlyRootfs, so nested mountpoint creation inside
  // an already-mounted dep folder works fine there.
  //
  // Why nested instead of flat NODE_PATH: a flat layout puts every package at
  // /sandbox/deps/{name} and only one version can occupy that path.  When two
  // packages in the tree need incompatible versions of the same dep (e.g. tar@6
  // needs minipass@3 CJS while another dep brought in minipass@4 ESM), the first
  // BFS winner lands in NODE_PATH and the loser fails at `class X extends require(…)`.
  //
  // The nested layout mirrors pnpm's resolution: each dep's sub-deps are mounted at
  // /sandbox/deps/{parent}/node_modules/{child}.  Node resolves require('minipass')
  // from /sandbox/deps/tar/node_modules/minizlib/index.js via:
  //   1. /sandbox/deps/tar/node_modules/minizlib/node_modules/minipass  ← mounted (v3)
  //   2. …NODE_PATH: /sandbox/deps/minipass                             ← v4, never reached
  //
  // `visited` tracks container paths already set up to break circular dep loops.
  // `depth` caps recursion for pathological trees.
  private async _resolveDepBindsNested(
    pkgDepsDir: string,
    skipSelf: string,
    skip: Set<string>,
    containerBase: string,
    visited: Set<string>,
    depth: number,
  ): Promise<string[]> {
    if (depth > 12) return []

    const binds: string[] = []
    let entries: Dirent[]
    try { entries = await fs.readdir(pkgDepsDir, { withFileTypes: true }) }
    catch { return binds }

    for (const entry of entries) {
      const { name } = entry
      if (name === '.bin' || name === skipSelf) continue

      if (name.startsWith('@')) {
        let scopeEntries: Dirent[]
        try { scopeEntries = await fs.readdir(path.join(pkgDepsDir, name), { withFileTypes: true }) }
        catch { continue }
        for (const se of scopeEntries) {
          const scopedName = `${name}/${se.name}`
          if (skip.has(scopedName)) continue
          const containerPath = `${containerBase}/${scopedName}`
          if (visited.has(containerPath)) continue
          visited.add(containerPath)
          try {
            const real = await fs.realpath(path.join(pkgDepsDir, name, se.name))
            binds.push(`${real}:${containerPath}:ro`)
            const subBinds = await this._resolveDepBindsNested(
              path.dirname(real), se.name, skip,
              `${containerPath}/node_modules`, visited, depth + 1,
            )
            binds.push(...subBinds)
          } catch { /* broken NTFS junction */ }
        }
      } else {
        if (skip.has(name)) continue
        const containerPath = `${containerBase}/${name}`
        if (visited.has(containerPath)) continue
        visited.add(containerPath)
        try {
          const real = await fs.realpath(path.join(pkgDepsDir, name))
          binds.push(`${real}:${containerPath}:ro`)
          const subBinds = await this._resolveDepBindsNested(
            path.dirname(real), name, skip,
            `${containerPath}/node_modules`, visited, depth + 1,
          )
          binds.push(...subBinds)
        } catch { /* broken NTFS junction */ }
      }
    }

    return binds
  }

  // Linux-only replacement for _resolveDepBindsNested. ReadonlyRootfs:true on Linux
  // means Docker/runc cannot create a mountpoint (for a bind OR a tmpfs) inside a
  // directory that's itself already covered by a `:ro` bind mount — confirmed via
  // `docker run --read-only` reproduction: mounting anything under an existing `:ro`
  // bind fails with "read-only file system" while the outer bind mount itself always
  // succeeds (its parent is still the pre-readonly base rootfs). So nested per-parent
  // binds (the Windows approach above) can never work here.
  //
  // Instead, every distinct dependency instance (deduped by realpath) gets its own
  // writable tmpfs "scope" directory at a flat, unique path (/sandbox/scopes/{idx}),
  // holding just that one package's real content as a `:ro` bind at .../{idx}/{name}.
  // Parent→child edges become symlinks placed at .../{parentIdx}/node_modules/{child}
  // (Node's resolver walks up checking <ancestor>/node_modules/<name>, so the child
  // must sit inside a node_modules folder alongside the parent's package dir, not as
  // a bare sibling of it) pointing at .../{childIdx}/{child}. sandbox-entrypoint.sh
  // creates these from the SANDBOXPM_LINKS manifest — writing a symlink into a tmpfs
  // scope dir never touches a read-only mount, so this sidesteps the limitation
  // entirely while still giving each version its own resolution path (same
  // non-collision guarantee the nested layout was designed for).
  private async _buildDepScopesLinux(
    pkgDepsDir: string,
    skipSelf: string,
    skip: Set<string>,
  ): Promise<{ scopeBinds: string[]; scopeTmpfs: string[]; links: string[] }> {
    const scopeBinds: string[] = []
    const scopeTmpfs: string[] = []
    const links: string[] = []
    const scopeByRealpath = new Map<string, number>()
    let counter = 0

    const resolveScope = async (real: string, name: string, depth: number): Promise<number | undefined> => {
      const existing = scopeByRealpath.get(real)
      if (existing !== undefined) return existing
      if (depth > 12) return undefined

      const idx = counter++
      scopeByRealpath.set(real, idx)
      scopeBinds.push(`${real}:/sandbox/scopes/${idx}/${name}:ro`)
      scopeTmpfs.push(`/sandbox/scopes/${idx}`)

      let entries: Dirent[]
      try { entries = await fs.readdir(path.dirname(real), { withFileTypes: true }) }
      catch { return idx }

      for (const entry of entries) {
        const entryName = entry.name
        if (entryName === '.bin' || entryName === name) continue
        if (entryName.startsWith('@')) {
          let scopeEntries: Dirent[]
          try { scopeEntries = await fs.readdir(path.join(path.dirname(real), entryName), { withFileTypes: true }) }
          catch { continue }
          for (const se of scopeEntries) {
            const scopedName = `${entryName}/${se.name}`
            if (skip.has(scopedName)) continue
            try {
              const childReal = await fs.realpath(path.join(path.dirname(real), entryName, se.name))
              const childIdx = await resolveScope(childReal, scopedName, depth + 1)
              if (childIdx !== undefined) {
                // Node's resolver checks <ancestor>/node_modules/<name>, so sub-deps must
                // live inside a node_modules folder alongside the scope's own package dir —
                // not as bare siblings (that check <ancestor>/<name> instead, never matches).
                links.push(`/sandbox/scopes/${idx}/node_modules/${scopedName}\t/sandbox/scopes/${childIdx}/${scopedName}`)
              }
            } catch { /* broken NTFS junction */ }
          }
        } else {
          if (skip.has(entryName)) continue
          try {
            const childReal = await fs.realpath(path.join(path.dirname(real), entryName))
            const childIdx = await resolveScope(childReal, entryName, depth + 1)
            if (childIdx !== undefined) {
              links.push(`/sandbox/scopes/${idx}/node_modules/${entryName}\t/sandbox/scopes/${childIdx}/${entryName}`)
            }
          } catch { /* broken NTFS junction */ }
        }
      }

      return idx
    }

    let entries: Dirent[]
    try { entries = await fs.readdir(pkgDepsDir, { withFileTypes: true }) }
    catch { return { scopeBinds, scopeTmpfs, links } }

    for (const entry of entries) {
      const name = entry.name
      if (name === '.bin' || name === skipSelf) continue
      if (name.startsWith('@')) {
        let scopeEntries: Dirent[]
        try { scopeEntries = await fs.readdir(path.join(pkgDepsDir, name), { withFileTypes: true }) }
        catch { continue }
        for (const se of scopeEntries) {
          const scopedName = `${name}/${se.name}`
          if (skip.has(scopedName)) continue
          try {
            const real = await fs.realpath(path.join(pkgDepsDir, name, se.name))
            const idx = await resolveScope(real, scopedName, 0)
            if (idx !== undefined) links.push(`/sandbox/deps/${scopedName}\t/sandbox/scopes/${idx}/${scopedName}`)
          } catch { /* broken NTFS junction */ }
        }
      } else {
        if (skip.has(name)) continue
        try {
          const real = await fs.realpath(path.join(pkgDepsDir, name))
          const idx = await resolveScope(real, name, 0)
          if (idx !== undefined) links.push(`/sandbox/deps/${name}\t/sandbox/scopes/${idx}/${name}`)
        } catch { /* broken NTFS junction */ }
      }
    }

    return { scopeBinds, scopeTmpfs, links }
  }

  // Returns true when the sandbox result warrants offering a native fallback:
  // either the container failed to start, or it succeeded but compiled a Linux
  // native addon that won't load on the Windows host.
  async isNativeFallbackCandidate(result: ScriptRunResult, packageDir: string): Promise<boolean> {
    if (result.sandboxReport?.status === 'blocked') return true
    if (result.exitCode === 0 && await this._hasIncompatibleNatives(packageDir)) return true
    return false
  }

  // Run a script directly on the host without Docker isolation.
  // The caller must have obtained explicit user consent before calling this.
  async runNative(script: TaggedScript, packageDir: string): Promise<ScriptRunResult> {
    const pkgId = `${script.name}@${script.version}`
    const startMs = Date.now()
    const { spawn } = await import('node:child_process')

    const cmd = process.platform === 'win32' ? 'cmd' : '/bin/sh'
    const cmdArgs = process.platform === 'win32'
      ? ['/S', '/C', script.command]
      : ['-c', script.command]

    // Prepend the package's sibling .bin so tools like node-pre-gyp,
    // prebuild-install, and node-gyp are found without being globally installed.
    const siblingBin = path.join(path.dirname(packageDir), '.bin')
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const augmentedPath = `${siblingBin}${pathSep}${process.env['PATH'] ?? ''}`

    return new Promise<ScriptRunResult>((resolve) => {
      const child = spawn(cmd, cmdArgs, {
        cwd: packageDir,
        stdio: 'inherit',
        env: { ...process.env, PATH: augmentedPath },
      })

      child.on('close', (code) => {
        resolve({
          packageId: pkgId,
          lifecycle: script.lifecycle,
          decision: 'run',
          exitCode: code ?? 0,
          durationMs: Date.now() - startMs,
          nativeRun: true,
        })
      })

      child.on('error', (err) => {
        process.stderr.write(`  Error running ${pkgId} natively: ${(err as Error).message}\n`)
        resolve({
          packageId: pkgId,
          lifecycle: script.lifecycle,
          decision: 'run',
          exitCode: 1,
          durationMs: Date.now() - startMs,
          nativeRun: true,
        })
      })
    })
  }

  // Scans packageDir for .node files with an ELF magic header, which indicates
  // a Linux binary that cannot be loaded on a Windows host.
  private async _hasIncompatibleNatives(packageDir: string): Promise<boolean> {
    if (process.platform !== 'win32') return false
    if (await this._isWindowsDaemon()) return false

    const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

    const scan = async (dir: string): Promise<boolean> => {
      let entries: Dirent[]
      try { entries = await fs.readdir(dir, { withFileTypes: true }) }
      catch { return false }

      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          // Don't descend into nested node_modules — those are deps, not compiled output
          if (entry.name === 'node_modules') continue
          if (await scan(full)) return true
        } else if (entry.name.endsWith('.node')) {
          try {
            const fh = await fs.open(full, 'r')
            const buf = Buffer.alloc(4)
            await fh.read(buf, 0, 4, 0)
            await fh.close()
            if (buf.equals(ELF_MAGIC)) return true
          } catch { /* unreadable — skip */ }
        }
      }
      return false
    }

    return scan(packageDir)
  }

  // Returns true when the Docker daemon is running in Windows containers mode.
  // Cached after the first call; safe to call on every run(). _switchDockerEngine
  // updates the cache directly once a switch is confirmed, so callers never need
  // to invalidate it themselves.
  private async _isWindowsDaemon(): Promise<boolean> {
    if (this._isWindowsDaemonResult !== undefined) return this._isWindowsDaemonResult
    if (process.platform !== 'win32') {
      this._isWindowsDaemonResult = false
      return false
    }
    try {
      const info = await this.docker.info()
      this._isWindowsDaemonResult = (info as Record<string, unknown>)['OSType'] === 'windows'
    } catch {
      this._isWindowsDaemonResult = false
    }
    return this._isWindowsDaemonResult
  }

  // True only when there's an actual chance of switching: host is Windows, the
  // daemon isn't already in Windows containers mode, Docker Desktop's CLI switcher
  // is installed where we expect it, and a previous attempt this install didn't
  // already prove it's unusable (see _windowsContainersUnavailable).
  async canOfferWindowsContainerRebuild(): Promise<boolean> {
    if (this._windowsContainersUnavailable) return false
    if (process.platform !== 'win32') return false
    if (await this._isWindowsDaemon()) return false
    return (await this._findDockerCliPath()) !== undefined
  }

  // Switches Docker Desktop to Windows containers (once per install — later calls
  // for other packages reuse the already-switched daemon) and reruns the script
  // through the normal sandboxed run(), which picks the Windows image/mounts once
  // _isWindowsDaemon() reports true.
  async runInWindowsContainer(script: TaggedScript, packageDir: string): Promise<ScriptRunResult> {
    if (!this._switchedToWindows) {
      // Set BEFORE attempting, not after success: the switch command can flip Docker
      // Desktop's configured engine even when the new engine never actually comes up
      // (confirmed live — the CLI context changed to desktop-windows while the daemon
      // stayed unreachable), so restoreDockerEngine must still try to put it back.
      this._switchedToWindows = true
      const switchResult = await this._switchDockerEngine('windows')
      if (!switchResult.ok) {
        this._windowsContainersUnavailable = true
        return {
          packageId: `${script.name}@${script.version}`,
          lifecycle: script.lifecycle,
          decision: 'run',
          exitCode: 1,
          sandboxReport: {
            networkConnections: [],
            blockedConnections: [],
            filesWritten: [],
            unexpectedActivity: [this._windowsSwitchFailureMessage(switchResult.reason)],
            status: 'blocked',
          },
        }
      }
    }
    return this.run(script, packageDir)
  }

  // Switches Docker Desktop back to Linux containers if runInWindowsContainer
  // touched the engine earlier in this install (whether or not that switch actually
  // succeeded). Safe to call unconditionally (e.g. from a finally block) — a no-op
  // when nothing was ever switched.
  async restoreDockerEngine(): Promise<void> {
    if (!this._switchedToWindows) return
    const result = await this._switchDockerEngine('linux')
    this._switchedToWindows = false
    if (!result.ok) {
      console.error(chalk.red(
        '\n⚠  Could not switch Docker Desktop back to Linux containers automatically.\n' +
        '   Please switch it back yourself from the Docker Desktop tray icon.\n'
      ))
    }
  }

  private _windowsSwitchFailureMessage(reason: DockerSwitchFailureReason | undefined): string {
    switch (reason) {
      case 'feature-disabled':
        return (
          'Docker Desktop could not start the Windows containers engine — the ' +
          '"Containers" Windows feature is disabled. Run this in an elevated ' +
          'PowerShell, then restart your computer: ' +
          'Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V,Containers -All'
        )
      case 'unavailable':
        return 'DockerCli.exe not found — cannot switch Docker Desktop to Windows containers.'
      default:
        return 'Timed out waiting for Docker Desktop to switch to Windows containers mode.'
    }
  }

  private async _findDockerCliPath(): Promise<string | undefined> {
    const candidates = [
      'C:\\Program Files\\Docker\\Docker\\DockerCli.exe',
    ]
    for (const candidate of candidates) {
      try {
        await fs.access(candidate)
        return candidate
      } catch { /* try next candidate */ }
    }
    return undefined
  }

  // Invokes Docker Desktop's engine switcher, then polls `docker info` until the
  // daemon reports the target OSType — the switch itself is async (Desktop restarts
  // its backend), so DockerCli's own exit code isn't a reliable success signal.
  //
  // Confirmed live against a real machine without the Windows "Containers" feature
  // enabled: Docker Desktop never brings up the Windows engine's named pipe at all
  // (`dockerDesktopWindowsEngine`) and needs the feature enabled + a reboot — no
  // amount of waiting fixes that. So once past a short grace period (Desktop needs
  // *some* time to attempt starting the engine before that pipe should exist), seeing
  // that exact connection failure is treated as a hard, un-retryable failure instead
  // of burning the full timeout.
  private async _switchDockerEngine(target: 'windows' | 'linux'): Promise<DockerSwitchResult> {
    const cliPath = await this._findDockerCliPath()
    if (!cliPath) return { ok: false, reason: 'unavailable' }

    const { execFile } = await import('node:child_process')
    const flag = target === 'windows' ? '-SwitchWindowsEngine' : '-SwitchLinuxEngine'
    await new Promise<void>((resolve) => {
      execFile(cliPath, [flag], () => resolve())
    })

    const WINDOWS_ENGINE_PIPE = 'dockerDesktopWindowsEngine'
    const graceDeadlineMs = Date.now() + 30_000
    const deadlineMs = Date.now() + 120_000

    while (Date.now() < deadlineMs) {
      await new Promise(resolve => setTimeout(resolve, 3_000))
      try {
        const info = await this.docker.info() as Record<string, unknown>
        if (info['OSType'] === target) {
          this._isWindowsDaemonResult = target === 'windows'
          return { ok: true }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (target === 'windows' && Date.now() > graceDeadlineMs && message.includes(WINDOWS_ENGINE_PIPE)) {
          return { ok: false, reason: 'feature-disabled' }
        }
        // otherwise keep polling — daemon may just be mid-restart
      }
    }
    return { ok: false, reason: 'timeout' }
  }
}

type DockerSwitchFailureReason = 'feature-disabled' | 'unavailable' | 'timeout'
type DockerSwitchResult = { ok: true } | { ok: false; reason: DockerSwitchFailureReason }

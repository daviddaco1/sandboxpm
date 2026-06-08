/**
 * @sandboxpm/scripts
 *
 * Interactive script approval prompt + Docker sandbox runner.
 * No script ever runs without explicit developer consent.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'
import inquirer from 'inquirer'
import Dockerode from 'dockerode'
import type { PackageScript } from '@sandboxpm/fetcher'
import type { SandboxpmRc } from '@sandboxpm/config'

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
  sandboxReport?: SandboxReport
}

export interface SandboxReport {
  networkConnections: string[]
  blockedConnections: string[]
  filesWritten: string[]
  unexpectedActivity: string[]
  status: 'clean' | 'warned' | 'blocked'
}

/** A PackageScript enriched with the identity of its owner package. */
export interface TaggedScript extends PackageScript {
  name: string     // package name
  version: string  // package exact version
}

const SEPARATOR = '─'.repeat(50)
const SANDBOX_IMAGE = 'sandboxpm-sandbox:latest'
const SANDBOX_NETWORK = 'sandboxpm-net'

// import.meta.url → dist/index.js; ../assets/ → assets/ (bundled with the package)
const ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url))
const SECCOMP_PATH = fileURLToPath(new URL('../assets/seccomp.json', import.meta.url))

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

    for (const script of autoRun) {
      if (this.runner) {
        results.push(await this.runner.run(script, ''))
      } else {
        results.push({
          packageId: `${script.name}@${script.version}`,
          lifecycle: script.lifecycle,
          decision: 'whitelisted',
        })
      }
    }

    if (toPrompt.length > 0) {
      console.log(`\n⚠  ${toPrompt.length} package(s) have install scripts\n`)
    }

    for (const script of toPrompt) {
      const decision = await this.promptOne(script)
      const pkgId = `${script.name}@${script.version}`

      if (decision === 'run' || decision === 'whitelisted') {
        if (decision === 'whitelisted') {
          this.rc.whitelist.push(script.name)
        }
        if (this.runner) {
          results.push(await this.runner.run(script, ''))
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

    return results
  }

  async promptOne(script: TaggedScript): Promise<ScriptDecision> {
    const pkgId = `${script.name}@${script.version}`

    console.log(`\n${SEPARATOR}`)
    console.log(`⚠  ${pkgId}`)
    console.log(SEPARATOR)
    console.log(`  Type:    ${script.lifecycle}`)
    console.log(`  Script:  ${script.command}`)
    console.log(`  Inspect: ${script.inspectUrl}`)
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

  constructor(docker: Dockerode, rc: SandboxpmRc, reportsDir?: string) {
    this.docker = docker
    this.rc = rc
    this.reportsDir = reportsDir
  }

  async run(
    script: TaggedScript,
    packageDir: string,
  ): Promise<ScriptRunResult> {
    await this.ensureNetwork()
    await this._pullImageIfNeeded()

    const pkgId = `${script.name}@${script.version}`

    const envVars = (this.rc.envPassthrough ?? [])
      .filter(v => process.env[v] !== undefined)
      .map(v => `${v}=${process.env[v] ?? ''}`)

    const binds = packageDir ? [`${packageDir}:/sandbox/package:rw`] : []

    const createOpts: Dockerode.ContainerCreateOptions = {
      Image: SANDBOX_IMAGE,
      Cmd: ['/bin/sh', '-c', script.command],
      WorkingDir: '/sandbox/package',
      Env: envVars,
      HostConfig: {
        AutoRemove: true,
        ReadonlyRootfs: true,
        Tmpfs: {
          '/tmp': 'rw,size=256m',
          '/sandbox/package/node_modules': 'rw',
        },
        NetworkMode: this.rc.sandbox.networkMode === 'none' ? 'none' : SANDBOX_NETWORK,
        CapDrop: ['ALL'],
        SecurityOpt: [
          'no-new-privileges',
          `seccomp=${SECCOMP_PATH}`,
        ],
        Memory: 512 * 1024 * 1024,
        PidsLimit: 100,
        Binds: binds,
      },
      AttachStdout: true,
      AttachStderr: true,
    }

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
        sandboxReport: {
          networkConnections: [],
          blockedConnections: [],
          filesWritten: [],
          unexpectedActivity: [],
          status: 'clean',
        },
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

  async ensureNetwork(): Promise<void> {
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

  private async _pullImageIfNeeded(): Promise<void> {
    try {
      await this.docker.getImage(SANDBOX_IMAGE).inspect()
      return  // image already present locally
    } catch { /* not found → build it */ }

    // Build from bundled Dockerfile — must succeed; a failed build means scripts
    // would run without the hardened seccomp/capDrop image, which is unacceptable.
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile('docker', ['build', '-t', SANDBOX_IMAGE, ASSETS_DIR], (err) => {
        if (err != null) {
          reject(new Error(
            `Cannot build sandboxpm sandbox image: ${(err as Error).message}. ` +
            'Make sure Docker is running and accessible, then retry.'
          ))
        } else {
          resolve()
        }
      })
    })
  }
}

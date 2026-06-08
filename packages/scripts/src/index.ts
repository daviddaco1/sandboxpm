/**
 * @sandboxpm/scripts
 *
 * The security-critical interactive script prompt and Docker sandbox runner.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PHILOSOPHY: No script ever runs without explicit developer consent.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Flow:
 *   1. Receive a list of PackageScript[] from the fetcher
 *   2. Filter out whitelisted/blacklisted packages (from .sandboxpmrc)
 *   3. For each remaining script, show an interactive prompt:
 *
 *      ──────────────────────────────────────────────────────
 *      ⚠  esbuild@0.19.4 has an install script
 *      ──────────────────────────────────────────────────────
 *        Type:    postinstall
 *        Script:  node install.js
 *        Inspect: https://unpkg.com/esbuild@0.19.4/install.js
 *
 *        Run this script? [y/N/inspect/always/never]
 *      ──────────────────────────────────────────────────────
 *
 *   4. Based on response:
 *      y       → run in Docker sandbox (see runInSandbox below)
 *      N       → skip, package installed without running the script
 *      inspect → open the inspectUrl in the default browser, re-ask
 *      always  → add to whitelist in .sandboxpmrc, then run
 *      never   → add to blacklist in .sandboxpmrc, skip now and always
 *
 *   5. If user chose to run: execute in ephemeral Docker container
 *      with maximum isolation (see sandbox config below).
 *
 * Docker sandbox config:
 *   - Base image: node:20-alpine
 *   - --rm (ephemeral)
 *   - --read-only root filesystem
 *   - --tmpfs /tmp:rw,size=256m
 *   - --network sandboxpm-net (egress only to npm registry)
 *   - --cap-drop ALL
 *   - --security-opt no-new-privileges
 *   - --memory 512m
 *   - --pids-limit 100
 *   - NO host env vars (zero passthrough by default)
 *   - Only the package's own directory is mounted (read-write)
 *   - Project source, SSH keys, .env — none of it is mounted
 */

export type ScriptDecision =
  | 'run'       // user said yes → ran in sandbox
  | 'skip'      // user said no → not run
  | 'whitelisted'  // was already in whitelist → ran in sandbox
  | 'blacklisted'  // was already in blacklist → skipped

export interface ScriptRunResult {
  packageId: string     // "name@version"
  lifecycle: string
  decision: ScriptDecision
  exitCode?: number     // present if decision is 'run' or 'whitelisted'
  durationMs?: number
  sandboxReport?: SandboxReport
}

export interface SandboxReport {
  networkConnections: string[]    // IPs/hosts the script tried to reach
  blockedConnections: string[]    // connections that were denied
  filesWritten: string[]          // relative paths written during script
  unexpectedActivity: string[]    // anything that matched a WARN/BLOCK policy
  status: 'clean' | 'warned' | 'blocked'
}

// TODO: implement ScriptPrompt class with:
//   constructor(rc: SandboxpmRc)
//   promptAll(scripts: PackageScript[]): Promise<ScriptRunResult[]>
//     → filters whitelist/blacklist first
//     → groups by package for clean output
//     → shows summary header: "N packages have install scripts"
//     → iterates each script interactively
//   promptOne(script: PackageScript): Promise<ScriptDecision>
//     → uses inquirer for the interactive prompt
//     → handles 'inspect' by opening browser and re-prompting
//   openInspect(url: string): Promise<void>
//     → uses 'open' package to open url in default browser

// TODO: implement SandboxRunner class with:
//   constructor(docker: Dockerode, rc: SandboxpmRc)
//   run(script: PackageScript, packageDir: string): Promise<ScriptRunResult>
//     → creates or reuses 'sandboxpm-net' Docker network
//     → pulls node:20-alpine if not present
//     → runs container with all security flags
//     → streams stdout/stderr to terminal with package prefix
//     → collects SandboxReport
//     → destroys container after completion
//   ensureNetwork(): Promise<void>
//     → creates bridge network with iptables rules restricting egress
//     → allows only registry.npmjs.org:443 and configured private registries

/**
 * Interactive prompt for typosquat/low-trust package findings, surfaced by
 * @sandboxpm/resolver during resolve(). Structurally mirrors ScriptPrompt in
 * ./index.ts, but a rejected package can't be selectively dropped from an
 * already-resolved tree the way a script can be skipped — "block" always
 * aborts the whole install.
 */

import inquirer from 'inquirer'
import chalk from 'chalk'
import type { SandboxpmRc } from '@sandboxpm/config'
import type { PackageRiskFinding } from '@sandboxpm/resolver'

export type PackageRiskDecision = 'proceed' | 'trust' | 'block'

export interface PackageRiskResult {
  finding: PackageRiskFinding
  decision: PackageRiskDecision | 'continue'
}

const SEPARATOR = '─'.repeat(50)

export class PackageRiskPrompt {
  private readonly rc: SandboxpmRc

  constructor(rc: SandboxpmRc) {
    this.rc = rc
  }

  private _partitionFindings(findings: PackageRiskFinding[]): {
    toPrompt: PackageRiskFinding[]
    autoContinue: PackageRiskFinding[]
    toAbort: PackageRiskFinding[]
  } {
    const toPrompt: PackageRiskFinding[] = []
    const autoContinue: PackageRiskFinding[] = []
    const toAbort: PackageRiskFinding[] = []

    for (const finding of findings) {
      if (this.rc.policies.onPackageRisk === 'continue') autoContinue.push(finding)
      else if (this.rc.policies.onPackageRisk === 'abort') toAbort.push(finding)
      else toPrompt.push(finding)
    }

    return { toPrompt, autoContinue, toAbort }
  }

  async promptAll(findings: PackageRiskFinding[]): Promise<PackageRiskResult[]> {
    if (findings.length === 0) return []

    const { toPrompt, autoContinue, toAbort } = this._partitionFindings(findings)
    const results: PackageRiskResult[] = []

    if (toAbort.length > 0) {
      const names = toAbort.map(f => `${f.name}@${f.version}`).join(', ')
      throw new Error(
        `Install aborted: ${toAbort.length} package(s) flagged as risky ` +
        `and policies.onPackageRisk is 'abort'. Packages: ${names}`
      )
    }

    for (const finding of autoContinue) {
      console.log(chalk.yellow(`⚠  ${finding.name}@${finding.version} — ${finding.reasons.join(', ')} (continuing)`))
      results.push({ finding, decision: 'continue' })
    }

    for (const finding of toPrompt) {
      const decision = await this.promptOne(finding)
      if (decision === 'trust') {
        this.rc.trustedPackages.push(finding.name)
      } else if (decision === 'block') {
        this.rc.blockedPackages.push(finding.name)
        throw new Error(`Install aborted: ${finding.name} was blocked during the risk prompt.`)
      }
      results.push({ finding, decision })
    }

    return results
  }

  async promptOne(finding: PackageRiskFinding): Promise<PackageRiskDecision> {
    const pkgId = `${finding.name}@${finding.version}`

    console.log(chalk.gray(`\n${SEPARATOR}`))
    console.log(chalk.yellow(`⚠  ${chalk.bold(pkgId)} looks risky`))
    console.log(chalk.gray(SEPARATOR))
    console.log(`  ${chalk.gray('Severity:')} ${finding.severity}`)
    for (const reason of finding.reasons) {
      console.log(`  ${chalk.gray('Reason:')}   ${reason}`)
    }
    console.log()

    while (true) {
      const { choice } = await inquirer.prompt<{ choice: string }>([{
        type: 'list',
        name: 'choice',
        message: 'Proceed with this package?',
        default: 'proceed',
        choices: [
          { name: 'y — proceed once', value: 'proceed' },
          { name: 'inspect — open on npmjs.com, then re-ask', value: 'inspect' },
          { name: 'always — trust and continue', value: 'trust' },
          { name: 'never — block and abort install', value: 'block' },
        ],
      }])

      if (choice === 'inspect') {
        await this.openInspect(`https://www.npmjs.com/package/${finding.name}`)
        continue
      }

      return choice as PackageRiskDecision
    }
  }

  async openInspect(url: string): Promise<void> {
    const { default: open } = await import('open')
    await open(url)
  }
}

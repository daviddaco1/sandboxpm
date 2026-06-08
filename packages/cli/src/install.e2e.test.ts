/**
 * End-to-end install test — runs only when SANDBOXPM_E2E=1
 * Tests a real install of is-odd@3.0.1 against the live npm registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

const E2E = process.env['SANDBOXPM_E2E'] === '1'

describe.skipIf(!E2E)('install — e2e against live registry', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-e2e-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('installs is-odd@3.0.1 and its transitive dep is-number@6.0.0', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'e2e-test', dependencies: { 'is-odd': '3.0.1' } }, null, 2),
    )

    const { install } = await import('./bin.js')
    await install({ cwd: tmpDir, prod: true })

    const oddIndexPath = path.join(tmpDir, 'node_modules', 'is-odd', 'index.js')
    const stat = await fs.stat(oddIndexPath)
    expect(stat.isFile()).toBe(true)

    const numberIndexPath = path.join(
      tmpDir, 'node_modules', '.sandboxpm', 'is-number@6.0.0', 'node_modules', 'is-number', 'index.js',
    )
    const numStat = await fs.stat(numberIndexPath)
    expect(numStat.isFile()).toBe(true)
  }, 60_000)
})

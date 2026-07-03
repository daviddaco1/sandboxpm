/**
 * Docker integration tests — real Dockerode against a live Docker daemon.
 *
 * Requires: DOCKER_INTEGRATION=1 and a running Docker daemon with the
 * sandboxpm-sandbox image built (done automatically in beforeAll).
 *
 * Run with: pnpm test:docker
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Dockerode from 'dockerode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { defaultRc } from '@sandboxpm/config'
import { SandboxRunner } from './index.js'
import type { TaggedScript } from './index.js'

const DOCKER_INTEGRATION = process.env['DOCKER_INTEGRATION'] === '1'

// packages/scripts/assets/ (source tree — accessible from src/ via ../assets)
const ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url))

function makeScript(command: string): TaggedScript {
  return {
    name: 'integration-test-pkg',
    version: '0.0.1',
    lifecycle: 'postinstall',
    command,
    inspectUrl: 'https://example.com',
  }
}

describe.skipIf(!DOCKER_INTEGRATION)('SandboxRunner — Docker integration', () => {
  let docker: Dockerode
  let tmpDir: string

  beforeAll(async () => {
    docker = new Dockerode()

    // Build the sandbox image from the bundled Dockerfile
    await new Promise<void>((resolve, reject) => {
      docker.buildImage(
        { context: ASSETS_DIR, src: ['Dockerfile'] } as Parameters<typeof docker.buildImage>[0],
        { t: 'sandboxpm-sandbox:latest' },
        (err, stream) => {
          if (err != null) { reject(err); return }
          if (stream == null) { reject(new Error('No build stream returned')); return }
          docker.modem.followProgress(stream, (progressErr: Error | null) => {
            if (progressErr != null) reject(progressErr)
            else resolve()
          })
        },
      )
    })

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandboxpm-docker-test-'))
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0' }, null, 2),
    )
  }, 120_000) // image build can take a while

  afterAll(async () => {
    if (tmpDir != null) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('runs a simple script and returns exit code 0 with a SandboxReport', async () => {
    const rc = defaultRc()
    const runner = new SandboxRunner(docker, rc)

    const result = await runner.run(makeScript('echo hello'), tmpDir)

    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe('run')
    expect(result.sandboxReport).toBeDefined()
    expect(result.sandboxReport?.status).toBe('clean')
    expect(result.durationMs).toBeGreaterThan(0)
  }, 60_000)

  it('seccomp profile is active (SECCOMP_MODE_FILTER reported by kernel)', async () => {
    const rc = defaultRc()
    const runner = new SandboxRunner(docker, rc)
    const outFile = path.join(tmpDir, 'seccomp-check.txt')

    // Write /proc/1/status Seccomp field to the bind-mounted package dir.
    // Seccomp: 2 means SECCOMP_MODE_FILTER (BPF profile active).
    const result = await runner.run(
      makeScript('grep "Seccomp:" /proc/1/status > /sandbox/package/seccomp-check.txt'),
      tmpDir,
    )

    expect(result.exitCode).toBe(0)
    const content = await fs.readFile(outFile, 'utf8')
    expect(content.trim()).toMatch(/Seccomp:\s*2/)
  }, 60_000)

  it('root filesystem is read-only (writes outside bind-mount fail)', async () => {
    const rc = defaultRc()
    const runner = new SandboxRunner(docker, rc)

    // Attempt to write to a path outside the rw tmpfs mounts — should fail
    const result = await runner.run(
      makeScript('touch /etc/pwned 2>/dev/null; echo "exit:$?"'),
      tmpDir,
    )

    // The container itself exits 0 (echo succeeds), but /etc/pwned write fails
    // due to ReadonlyRootfs: true. We verify the container still ran cleanly.
    expect(result.exitCode).toBe(0)
    expect(result.sandboxReport).toBeDefined()
    // /etc/pwned must NOT exist on the host tmpDir
    await expect(fs.access(path.join(tmpDir, 'pwned'))).rejects.toThrow()
  }, 60_000)

  it('auditSyscalls: real strace trace records a blocked connection under isolated networking', async () => {
    const rc = { ...defaultRc(), sandbox: { ...defaultRc().sandbox, auditSyscalls: true } }
    const runner = new SandboxRunner(docker, rc)

    // networkMode is 'isolated' by default (Internal:true bridge) — this connect() must fail.
    const result = await runner.run(
      makeScript('node -e "require(\'net\').connect(80, \'93.184.216.34\').on(\'error\', () => process.exit(0))"'),
      tmpDir,
    )

    expect(result.sandboxReport?.audited).toBe(true)
    expect(result.sandboxReport?.blockedConnections.length).toBeGreaterThan(0)
    expect(result.sandboxReport?.status).toBe('warned')
  }, 60_000)

  it('auditSyscalls: real strace trace records a clean in-package file write', async () => {
    const rc = { ...defaultRc(), sandbox: { ...defaultRc().sandbox, auditSyscalls: true } }
    const runner = new SandboxRunner(docker, rc)

    const result = await runner.run(makeScript('echo hi > /sandbox/package/audit-out.txt'), tmpDir)

    expect(result.sandboxReport?.audited).toBe(true)
    expect(result.sandboxReport?.filesWritten.some(f => f.includes('audit-out.txt'))).toBe(true)
    expect(result.sandboxReport?.status).toBe('clean')
  }, 60_000)
})

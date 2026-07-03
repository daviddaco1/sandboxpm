#!/usr/bin/env node
// packages/scripts/assets/ is the canonical source (it's what SandboxRunner actually
// builds images from and what ships in the published npm package). docker/sandbox/
// is a generated mirror for people browsing/building the sandbox image standalone.
// Run with --check to verify the mirror is in sync instead of overwriting it (used in CI).
import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE_DIR = join(ROOT, 'packages/scripts/assets')
const MIRROR_DIR = join(ROOT, 'docker/sandbox')
const FILES = ['Dockerfile', 'seccomp.json', 'seccomp-audit.json', 'sandbox-entrypoint.sh']

const check = process.argv.includes('--check')
let drifted = false

for (const file of FILES) {
  const source = await readFile(join(SOURCE_DIR, file), 'utf8')

  if (check) {
    const mirror = await readFile(join(MIRROR_DIR, file), 'utf8').catch(() => null)
    if (mirror !== source) {
      console.error(`out of sync: docker/sandbox/${file} does not match packages/scripts/assets/${file}`)
      drifted = true
    }
  } else {
    await writeFile(join(MIRROR_DIR, file), source)
    console.log(`synced docker/sandbox/${file}`)
  }
}

if (check && drifted) {
  console.error('\nRun `node scripts/sync-docker-assets.mjs` to fix.')
  process.exit(1)
}

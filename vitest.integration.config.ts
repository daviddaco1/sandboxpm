import { defineConfig } from 'vitest/config'

// Dedicated config for `test:e2e`/`test:docker`. The main vitest.config.ts
// excludes `**/*.e2e.test.ts` and `**/*.integration.test.ts` on purpose, as a
// second layer of protection beyond each file's own `describe.skipIf(!ENV)`
// guard — so a forgotten guard can never make the live-registry/live-Docker
// tests run as part of the default `pnpm test`. vitest's CLI `--exclude` flag
// only appends to config excludes rather than replacing them, so reaching
// these files at all requires a separate config with no such exclude.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.{e2e,integration}.test.ts'],
  },
})

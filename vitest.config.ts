import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/*.e2e.test.ts', '**/*.integration.test.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.integration.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
      },
      reporter: ['text', 'lcov'],
    },
  },
})

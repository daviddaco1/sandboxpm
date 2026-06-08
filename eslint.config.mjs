import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

const baseLanguageOptions = {
  parser: tsParser,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
}

export default [
  // ─── Production source ────────────────────────────────────────────────────
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/dist/**', '**/*.test.ts', '**/*.e2e.test.ts', '**/*.integration.test.ts', '**/node_modules/**'],
    languageOptions: baseLanguageOptions,
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'off',
    },
  },

  // ─── Test files (relaxed rules for mocks and spies) ──────────────────────
  {
    files: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.e2e.test.ts',
      'packages/*/src/**/*.integration.test.ts',
    ],
    ignores: ['**/dist/**', '**/node_modules/**'],
    languageOptions: baseLanguageOptions,
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'off',
    },
  },
]

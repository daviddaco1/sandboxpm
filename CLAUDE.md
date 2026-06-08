# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`sandboxpm` is a security-first Node.js package manager. Its core philosophy:
- **Zero script execution without consent** — packages are fetched and extracted but never run code automatically
- **Content-Addressable Store (CAS)** — tarballs stored once at `~/.sandboxpm/store/{sha512-hex}` and hard-linked into project `node_modules`
- **Non-flat `node_modules`** — pnpm-style structure to prevent phantom dependencies
- **Docker isolation** — package scripts run in ephemeral Alpine containers with a seccomp syscall whitelist

## Commands

```bash
# Build all packages (TypeScript project references)
yarn build          # or: tsc --build

# Watch mode during development
yarn dev            # or: tsc --build --watch

# Run tests (all packages via vitest)
yarn test

# Run tests in watch mode
yarn test:watch

# Lint TypeScript source
yarn lint           # runs eslint on packages/*/src/**/*.ts

# Clean build artifacts
yarn clean
```

Run a single test file:
```bash
npx vitest run packages/<package>/src/<file>.test.ts
```

## Monorepo Architecture

Yarn workspaces with 7 packages. Build and implement in this dependency order:

```
config → store → fetcher → resolver → linker → scripts → cli
```

| Package | Responsibility |
|---------|---------------|
| `packages/config` | Parse `.sandboxpmrc` (YAML) + `~/.sandboxpm/config.json` |
| `packages/store` | CAS storage: SHA-512 keyed hard links in `~/.sandboxpm/store/` |
| `packages/fetcher` | Download tarballs from npm registry, verify SHA-512, extract to store |
| `packages/resolver` | Semver resolution, dependency tree, lockfile read/write |
| `packages/linker` | Build non-flat `node_modules` using hard links from store |
| `packages/scripts` | Interactive script approval UI + Docker sandbox runner via dockerode |
| `packages/cli` | Entry point (`bin.ts`): orchestrates all packages, commander.js CLI |

Each package lives at `packages/<name>/src/index.ts` and exports its public interface.

## TypeScript Configuration

- **ES modules throughout** — all packages have `"type": "module"` in their `package.json`
- **Strict settings** in `tsconfig.base.json`: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `strict: true`
- **Project references** in root `tsconfig.json` enable incremental builds across packages
- Target: `ES2022`, module resolution: `bundler`, declarations emitted to `dist/`

## Docker Sandbox

`docker/sandbox/` contains the isolated script execution environment:
- **Dockerfile**: Alpine Node 20, non-root user (uid 1001), minimal toolset (no curl/wget/ssh)
- **seccomp.json**: Explicit syscall allowlist — scripts cannot make arbitrary kernel calls

The `scripts` package uses `dockerode` to spin up ephemeral containers from this image.

## Implementation Notes (from AGENT_PROMPT.md)

- Use `fs/promises` (not `fs`) everywhere
- Use Node built-in `crypto` for SHA-512 hashing
- Use `tar` npm package for tarball extraction
- The store links files by hard link (`fs.link`), not symlink
- Fetcher must verify tarball integrity before any extraction
- Resolver must write a lockfile compatible with the store's CAS approach
- CLI commands: `install`, `add`, `remove`, `audit`, `cache clean`, `whitelist`, `init`

## Current Status

MVP Phase 1 — scaffold complete, implementations are `TODO`. All `src/index.ts` files contain interface/type definitions but no working logic. No tests exist yet.

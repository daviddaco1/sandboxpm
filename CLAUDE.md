# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`sandboxpm` is a security-first Node.js package manager. Its core philosophy:
- **Zero script execution without consent** — `preinstall`/`install`/`postinstall` scripts are never run automatically; the developer is prompted per-package with an option to inspect, always-allow, or always-block
- **Content-Addressable Store (CAS)** — every file is stored once at `~/.sandboxpm/store/{sha512-hex}` and hard-linked into project `node_modules`
- **Non-flat `node_modules`** — pnpm-style structure (`node_modules/.sandboxpm/{name}@{version}/...`) to prevent phantom dependency access
- **Docker isolation** — approved scripts run in ephemeral, capability-dropped containers with a seccomp syscall allowlist and no host credential/network access by default

This is a pnpm workspace, not yarn — `packageManager` is pinned in the root `package.json`. Note: `.github/workflows/ci.yml` pins its own `pnpm/action-setup` version independently, which can drift from the `package.json` value — check both if you hit install/lockfile mismatches in CI.

## Commands

```bash
pnpm install                     # install workspace deps

pnpm build                       # tsc --build (respects project references / package order below)
pnpm dev                         # tsc --build --watch

pnpm test                        # vitest run, unit tests only
pnpm test:watch                  # vitest watch mode
pnpm test:coverage               # vitest run --coverage (thresholds: 80% lines/functions, 75% branches)
pnpm test:e2e                    # install.e2e.test.ts, gated by SANDBOXPM_E2E=1 (CI runs this only on push to main)
pnpm test:docker                 # docker.integration.test.ts, gated by DOCKER_INTEGRATION=1, needs a real Docker daemon

pnpm lint                        # eslint on packages/*/src/**/*.ts (no-explicit-any and no-non-null-assertion are errors; relaxed for *.test.ts)
pnpm clean                       # remove dist/ and *.tsbuildinfo across packages

pnpm sync-assets                 # regenerate docker/sandbox/ mirror from packages/scripts/assets/ (the canonical source)
pnpm sync-assets:check           # verify the mirror is in sync instead of writing it (what CI runs)
```

Run a single test file:
```bash
npx vitest run packages/<package>/src/index.test.ts
```

Build/test a single package (pnpm workspace filter):
```bash
pnpm --filter @sandboxpm/<package> build
```

CI (`.github/workflows/ci.yml`) runs `pnpm audit` → build → lint → `sync-assets:check` → test → coverage on every push/PR, and e2e only on pushes to `main`.

## Monorepo Architecture

pnpm workspace (`pnpm-workspace.yaml`), 7 packages wired together with TypeScript project references (`tsconfig.json`). Build/implementation dependency order:

```
config → store → fetcher → resolver → linker → scripts → cli
```

| Package | Responsibility | Key exports |
|---------|---------------|--------------|
| `packages/config` | `.sandboxpmrc` (YAML) + `~/.sandboxpm/config.json` | `loadRc`, `saveRc`, `mergeRc`, `loadGlobalConfig` |
| `packages/store` | CAS: SHA-512 keyed hard links in `~/.sandboxpm/store/` | `CASStore` (`put`, `link`, `verify`, `gc`), `hashFile` |
| `packages/fetcher` | Tarball download, integrity verification, extraction into the store | `Fetcher` (async-generator `fetch()`), `buildInspectUrl` |
| `packages/resolver` | Semver resolution, dependency tree, `sandboxpm.lock` | `Resolver` (`resolve`, `resolveFromLock`) |
| `packages/linker` | Non-flat `node_modules` from store hard links + symlinks | `Linker` (`link`, `unlink`) |
| `packages/scripts` | Interactive script approval + Docker/Hyper-V sandbox runner | `ScriptPrompt`, `SandboxRunner` |
| `packages/cli` | `bin.ts`: commander.js entry point, orchestrates the above | `install`, `add`, `remove`, `init`, `audit`, `whitelist`, `cache`, `config`, `ls`, `why`, `outdated`, `info`, `search`, `run`/`exec`, `update`, `version`, `link`/`unlink`, `pack`/`publish`, `login`/`logout` |

None of these are TODO scaffolds anymore — every `src/index.ts` has a real implementation and a colocated `*.test.ts`. `bin.ts` (~1,600 lines) is a full npm-compatible CLI surface, not just an installer — it also covers publishing (`pack`/`publish`/`login`/`logout`), local dev linking (`link`/`unlink`), and script running (`run`/`exec`, plus `test`/`start`/`stop` aliases; `exec` always sandboxes, `run` only with `--sandbox`). Cross-package wiring lives entirely in `packages/cli/src/bin.ts`'s `install()` (one `CASStore`/`Resolver`/`Fetcher`/`Linker`/`SandboxRunner` instantiated per CLI invocation — no shared singleton/DI container).

### Install flow (what actually happens on `sandboxpm install`)

1. **Resolver**: BFS over the dependency graph, first-satisfying-version-wins per name (pnpm-style dedup); peer dep failures warn and skip rather than throwing. Writes `sandboxpm.lock` (JSON, sorted keys, atomic write).
2. **Fetcher**: streams each tarball while hashing, and verifies the hash against the registry's `dist.integrity` **before** extracting — never extract-then-verify. Skips re-downloading if a cached per-tarball manifest shows every file hash is already in the store. Concurrency-limited via `p-limit`.
3. **Store**: `put()` copies into the CAS via a temp-file + atomic rename; `link()` hard-links into place and falls back to `copyFile` on `EXDEV`/`EPERM` (cross-volume stores, OneDrive, or Windows without Developer Mode).
4. **Linker**: builds `node_modules/.sandboxpm/{name}@{version}/node_modules/{name}` from store hard links, then symlinks (junctions on Windows) direct deps into the root `node_modules` and transitive deps into each package's own scope. Falls back to `.cmd` shims when Windows file-symlink creation hits `EPERM`.
5. **ScriptPrompt / SandboxRunner**: install scripts are partitioned by `.sandboxpmrc` policy into whitelist/blacklist/prompt/abort; interactive decisions can persist back to `.sandboxpmrc`. Approved scripts run via `dockerode` in a read-only, `CapDrop: ALL`, seccomp-restricted container on an isolated bridge network; on Windows Docker daemons it instead uses `Isolation: hyperv` (no seccomp/CapDrop there). A native (unsandboxed) fallback exists for sandbox-start failures or Linux-ELF/Windows-host native-addon mismatches, but requires an explicit double-confirmation.

### Config resolution

`loadRc` walks up from the project directory looking for `.sandboxpmrc`, validates enum fields (`sandbox.networkMode`, `policies.onWarn`, `policies.onBlock`), and deep-merges onto defaults — it never throws for a missing file. This is separate from the global JSON config at `~/.sandboxpm/config.json` (`storeDir`, `cacheDir`, `reportsDir`), written via temp-file + rename. See `.sandboxpmrc.example` at the repo root for the full schema (sandbox resource limits, policy actions, registries, whitelist/blacklist, env passthrough, CAS gc settings).

## TypeScript Configuration

- **ES modules throughout** — every package has `"type": "module"`
- **Module resolution is `Node16`** (not `bundler`) — import specifiers need explicit extensions/paths as Node16 requires
- **Strict settings** in `tsconfig.base.json`: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `strict: true`
- Root `tsconfig.json` declares project references in the same dependency order as the table above; `*.test.ts` is excluded from the build graph (vitest handles those directly)
- Target `ES2022`; declarations/sourcemaps emitted to each package's `dist/`

## Docker Sandbox

Two sandbox images, selected by which OS the connected Docker daemon runs:
- `packages/scripts/assets/` (the canonical source — it's what `SandboxRunner` actually builds images from and what ships in the published npm package; `docker/sandbox/` is a generated mirror for people browsing/building the image standalone, kept in sync via `pnpm sync-assets`): Alpine Node 20, non-root uid 1001, only `python3`/`make`/`g++` for native builds (no curl/wget/ssh). `sandbox-entrypoint.sh` copies `node-addon-api`/`nan` headers into the writable tmpfs so `node-gyp` can write build files back under a read-only rootfs. `seccomp.json` is an explicit syscall allowlist, inlined into `SecurityOpt` (Docker requires the seccomp JSON inline, not a host file path).
- `packages/scripts/assets/windows/Dockerfile`: `node:20-windowsservercore-ltsc2022` + VS Build Tools C++ workload (~8GB image), used so native addons compile as real Windows binaries instead of Linux ELFs. No non-root user (Hyper-V isolation is the security boundary instead); no entrypoint (the CLI supplies the full `Cmd`). Requires Docker Desktop switched to Windows-containers mode.

`SandboxRunner` builds nested (non-flat) dependency bind-mounts mirroring the on-disk `.sandboxpm` tree rather than a flat `NODE_PATH`, specifically to avoid version collisions when two scripts need different versions of the same dependency name.

When `.sandboxpmrc`'s `sandbox.auditSyscalls` is on (Linux only), the runner swaps in `seccomp-audit.json` (a permissive allowlist) plus `CapAdd: SYS_PTRACE` and traces the script with `strace` to produce a real syscall report; otherwise the audit report is a cosmetic stub.

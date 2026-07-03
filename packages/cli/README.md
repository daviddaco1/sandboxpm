# sandboxpm

> A secure, zero-trust package manager for the Node.js ecosystem.

**[Website & full documentation →](https://sandboxpm.andresodev.com)**

sandboxpm never executes install scripts without explicit developer consent. Every package is downloaded directly from the registry, verified via SHA-512, stored once in a global content-addressable store (CAS), and hard-linked into your project — just like pnpm, but with security-first design at its core.

---

## Installation

### Global (recommended)

Install once, use in any project — works the same on macOS, Linux, and Windows:

```bash
npm install -g sandboxpm
# or
pnpm add -g sandboxpm
# or
yarn global add sandboxpm
```

### Local (per-project)

If you only want sandboxpm available inside a single project:

```bash
npm install --save-dev sandboxpm
```

Then run it via `npx sandboxpm <command>` or add it to your `package.json` scripts.

Requires Node.js 18+. Docker is only needed if a package you install has an install script you choose to run (see [Requirements](#requirements)).

---

## Why sandboxpm?

npm, pnpm, and yarn all execute `preinstall`, `install`, and `postinstall` scripts **silently** during installation. A malicious package can read your SSH keys, exfiltrate `.env` files, or install backdoors — all during a simple `sandboxpm install`.

sandboxpm solves this by:

- **Never executing scripts automatically.** Every script requires explicit opt-in via an interactive CLI prompt.
- **Showing you what each script does** — type, full command, and a direct link to inspect the source file.
- **Running approved scripts in an isolated Docker sandbox** — never on your host system.
- **Storing packages once globally** using a content-addressable store with hard links, identical to pnpm's approach.

---

## How it works

### Installation flow

```
sandboxpm install

✓ Resolving dependencies... (47 packages)
✓ Downloading tarballs... (12 new, 35 from store)
✓ Verifying SHA-512... OK
✓ Linking node_modules...

──────────────────────────────────────────────────────
⚠  3 packages have install scripts
──────────────────────────────────────────────────────

  1. esbuild@0.19.4
     Type:    postinstall
     Script:  node install.js
     Inspect: https://unpkg.com/esbuild@0.19.4/install.js

     Run this script? [y/N/inspect/always/never]
```

### Content-Addressable Store (CAS)

Every file from every package is stored once in `~/.sandboxpm/store/` by its SHA-512 hash. When a package is installed in a project, its files are **hard-linked** from the store — no duplication across projects. Identical to how pnpm works internally.

```
~/.sandboxpm/store/
└── sha512-{hash}    ← one file, shared across all projects via hard links

project-a/node_modules/express  →  hard link to store
project-b/node_modules/express  →  same hard link, zero extra disk space
```

### Non-flat node_modules

Only direct dependencies appear in the root `node_modules/`. Transitive dependencies live in `node_modules/.sandboxpm/`. This prevents phantom dependency access — your code can only import what you explicitly declared.

---

## Architecture

```
packages/
├── cli/           # Entry point, command parsing (commander.js)
├── resolver/      # Semver resolution, registry API, lockfile
├── fetcher/       # Tarball download, SHA-512 verification
├── store/         # Content-addressable store, hard link management
├── linker/        # node_modules structure, symlinks
├── scripts/       # Interactive script prompt, Docker sandbox runner
└── config/        # .sandboxpmrc parser, whitelist/blacklist

docker/
└── sandbox/       # Dockerfile for isolated script execution

policies/          # YAML allow/warn/block rules for sandbox
```

---

## Commands

| Command | Description |
|---------|-------------|
| `sandboxpm install` | Install all dependencies from package.json |
| `sandboxpm add <pkg>` | Add and install a new package |
| `sandboxpm remove <pkg>` | Remove a package |
| `sandboxpm audit` | Show behavioral history of installed packages |
| `sandboxpm cache clean` | Clear the CAS store |
| `sandboxpm whitelist add <pkg>` | Trust a package's scripts permanently |
| `sandboxpm init` | Initialize `.sandboxpmrc` in a project |

---

## Tech Stack

- **Runtime:** Node.js 18+ with TypeScript
- **CLI:** commander.js
- **Docker API:** dockerode
- **Registry client:** Custom fetch against registry.npmjs.org
- **Config:** js-yaml (.sandboxpmrc)
- **Logging:** pino + ora + chalk
- **Tests:** vitest

---

## Requirements

- Node.js 18+
- Docker Engine 24+ (Linux / macOS / Windows with WSL2)
- 2GB free disk space for base image and initial cache

---

## Security Model

sandboxpm operates on a **zero-trust** principle:

- No package has filesystem or network access during installation unless explicitly granted
- Scripts are never executed silently — every script requires developer consent
- Approved scripts run in ephemeral Docker containers with no access to host credentials, SSH keys, or environment variables
- All tarballs are verified against the SHA-512 published by the npm registry before extraction

---

## Project Status

📦 **v0.1.0 — first published release**

- [x] Repository structure
- [x] CAS store + fetcher
- [x] Semver resolver
- [x] node_modules linker
- [x] Interactive script prompt
- [x] Docker sandbox runner
- [x] Full CLI

---

## License

[MIT](./LICENSE)

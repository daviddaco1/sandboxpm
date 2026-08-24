# Changelog

All notable changes to sandboxpm are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.3] — 2026-08-24

### Security

- `next` bumped to 15.5.23, fixing SSRF via `rewrites`, DoS in App Router Server
  Actions, cache-confusion of response bodies, unauthenticated disclosure of
  Server Function endpoints, and an image-optimization SVG DoS.
- `js-yaml` bumped to 4.3.1, fixing quadratic CPU consumption via `!!omap` and
  YAML merge-key chains.
- `tar` bumped to 7.5.22, fixing uncontrolled recursion in `mapHas`/`filesFilter`
  that allowed a stack-overflow DoS via a crafted long-path tarball.
- `postcss` bumped to 8.5.26, fixing path traversal in previous-source-map
  auto-loading.
- `sharp` (transitive, via `next`) pinned to `>=0.35.0` and `protobufjs`
  (transitive, via `dockerode`) pinned to `^7.6.5` via `pnpm-workspace.yaml`
  overrides, fixing inherited libvips CVEs and a DoS in `.proto` option parsing.
- All 19 Dependabot alerts open against this repository at the time are
  resolved by the above; `pnpm audit` reports zero known vulnerabilities.

### Changed

- Routine dependency maintenance within existing semver ranges: `semver`,
  `@types/dockerode`, `@types/pino`, `@types/semver`, and website-side
  `react`, `react-dom`, `@next/mdx`, `eslint`, `@typescript-eslint/*`, and
  related packages.
- CI: bumped pinned SHAs for `actions/checkout` (v4 → v7.0.1), `actions/setup-node`
  (v4 → v7.0.0), and `pnpm/action-setup` (v4 → v6.0.10).

> A handful of Dependabot PRs proposing major-version bumps (TypeScript 7,
> ESLint 10, `@typescript-eslint` 8, Vite 8, `rimraf` 6, `ora` 9) remain open
> for separate review — none address a security advisory, and each carries a
> real risk of breaking the build or lint config.

## [0.1.2] — 2026-07-20

### Added

- Package-risk / typosquat detection: `checkPackageRisk` scans every resolved
  package name against a bundled snapshot of popular packages during
  resolution, escalating to `high` severity for new or single-maintainer
  packages; findings surface through `PackageRiskPrompt` and `sandboxpm audit`.

### Changed

- CI now runs the e2e suite only on pushes to `main`, not on every PR.

## [0.1.1] — 2026-07-03

### Added

- Initial documentation site (`packages/website`) and per-package `LICENSE`
  files.

### Changed

- Raised the minimum supported Node.js version to 22.
- Improved Windows support: symlink handling in the linker falls back
  correctly when file-symlink creation is denied.

### Security

- Dependency fixes for `postcss`, `uuid`, and `protobufjs`.

## [0.1.0] — 2026-06-08

### Added

- Initial monorepo scaffold: `config`, `store`, `fetcher`, `resolver`,
  `linker`, `scripts`, and `cli` packages.
- Content-addressable store with SHA-512-keyed hard links.
- Non-flat, pnpm-style `node_modules` layout.
- Interactive install-script consent prompt and Docker/Hyper-V sandbox runner.

[0.1.3]: https://github.com/daviddaco1/sandboxpm/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/daviddaco1/sandboxpm/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/daviddaco1/sandboxpm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/daviddaco1/sandboxpm/releases/tag/v0.1.0

/**
 * @sandboxpm/config
 *
 * Parses and validates .sandboxpmrc (YAML) and manages the global
 * config at ~/.sandboxpm/config.json.
 *
 * .sandboxpmrc lives at the root of each project.
 * ~/.sandboxpm/config.json is the global store config.
 */

export interface SandboxConfig {
  memory: string        // e.g. "1g"
  cpus: number          // e.g. 1.0
  timeout: number       // seconds
  networkMode: 'isolated' | 'restricted' | 'none'
}

export interface PoliciesConfig {
  onWarn: 'continue' | 'prompt' | 'abort'
  onBlock: 'abort' | 'prompt'
  extraPolicyDirs: string[]
}

export interface RegistryConfig {
  url: string
  token?: string        // for private registries
}

export interface CacheConfig {
  enabled: boolean
  maxSizeGb: number
  ttlDays: number
}

export interface SandboxpmRc {
  version: number
  sandbox: SandboxConfig
  policies: PoliciesConfig
  registries: RegistryConfig[]
  whitelist: string[]   // packages whose scripts are always allowed
  blacklist: string[]   // packages whose scripts are always blocked
  envPassthrough: string[]  // env var names to pass into sandbox (non-sensitive only)
  cache: CacheConfig
}

export interface GlobalConfig {
  storeDir: string      // default: ~/.sandboxpm/store
  cacheDir: string      // default: ~/.sandboxpm/cache
  reportsDir: string    // default: ~/.sandboxpm/reports
}

// TODO: implement loadRc(projectDir: string): Promise<SandboxpmRc>
// TODO: implement saveRc(projectDir: string, rc: SandboxpmRc): Promise<void>
// TODO: implement loadGlobalConfig(): Promise<GlobalConfig>
// TODO: implement defaultRc(): SandboxpmRc
// TODO: implement mergeRc(base: SandboxpmRc, overrides: Partial<SandboxpmRc>): SandboxpmRc

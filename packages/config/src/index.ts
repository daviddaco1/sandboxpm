/**
 * @sandboxpm/config
 *
 * Parses and validates .sandboxpmrc (YAML) and manages the global
 * config at ~/.sandboxpm/config.json.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'js-yaml'

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

export function defaultRc(): SandboxpmRc {
  return {
    version: 1,
    sandbox: {
      memory: '1g',
      cpus: 1.0,
      timeout: 120,
      networkMode: 'isolated',
    },
    policies: {
      onWarn: 'prompt',
      onBlock: 'abort',
      extraPolicyDirs: [],
    },
    registries: [
      { url: 'https://registry.npmjs.org' },
    ],
    whitelist: [],
    blacklist: [],
    envPassthrough: [],
    cache: {
      enabled: true,
      maxSizeGb: 10,
      ttlDays: 30,
    },
  }
}

function validateRc(raw: unknown, filePath: string): SandboxpmRc {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid .sandboxpmrc at ${filePath}: must be a YAML object`)
  }
  const obj = raw as Record<string, unknown>

  if ('version' in obj && typeof obj['version'] !== 'number') {
    throw new Error(`Invalid .sandboxpmrc at ${filePath}: "version" must be a number`)
  }

  const sandbox = obj['sandbox']
  if (sandbox !== undefined) {
    if (typeof sandbox !== 'object' || sandbox === null) {
      throw new Error(`Invalid .sandboxpmrc at ${filePath}: "sandbox" must be an object`)
    }
    const s = sandbox as Record<string, unknown>
    const validNetworkModes = ['isolated', 'restricted', 'none']
    if ('networkMode' in s && !validNetworkModes.includes(s['networkMode'] as string)) {
      throw new Error(
        `Invalid .sandboxpmrc at ${filePath}: "sandbox.networkMode" must be one of ${validNetworkModes.join(', ')}`
      )
    }
  }

  const policies = obj['policies']
  if (policies !== undefined) {
    if (typeof policies !== 'object' || policies === null) {
      throw new Error(`Invalid .sandboxpmrc at ${filePath}: "policies" must be an object`)
    }
    const p = policies as Record<string, unknown>
    const validOnWarn = ['continue', 'prompt', 'abort']
    const validOnBlock = ['abort', 'prompt']
    if ('onWarn' in p && !validOnWarn.includes(p['onWarn'] as string)) {
      throw new Error(
        `Invalid .sandboxpmrc at ${filePath}: "policies.onWarn" must be one of ${validOnWarn.join(', ')}`
      )
    }
    if ('onBlock' in p && !validOnBlock.includes(p['onBlock'] as string)) {
      throw new Error(
        `Invalid .sandboxpmrc at ${filePath}: "policies.onBlock" must be one of ${validOnBlock.join(', ')}`
      )
    }
  }

  return mergeRc(defaultRc(), obj as Partial<SandboxpmRc>)
}

export function mergeRc(base: SandboxpmRc, overrides: Partial<SandboxpmRc>): SandboxpmRc {
  return {
    version: overrides.version ?? base.version,
    sandbox: overrides.sandbox != null
      ? { ...base.sandbox, ...overrides.sandbox }
      : base.sandbox,
    policies: overrides.policies != null
      ? { ...base.policies, ...overrides.policies }
      : base.policies,
    registries: overrides.registries ?? base.registries,
    whitelist: overrides.whitelist ?? base.whitelist,
    blacklist: overrides.blacklist ?? base.blacklist,
    envPassthrough: overrides.envPassthrough ?? base.envPassthrough,
    cache: overrides.cache != null
      ? { ...base.cache, ...overrides.cache }
      : base.cache,
  }
}

/** Walk up from `dir` until a .sandboxpmrc is found, then merge with defaults. */
export async function loadRc(projectDir: string): Promise<SandboxpmRc> {
  let dir = path.resolve(projectDir)
  const root = path.parse(dir).root

  while (true) {
    const candidate = path.join(dir, '.sandboxpmrc')
    try {
      const content = await fs.readFile(candidate, 'utf8')
      const raw = yaml.load(content)
      return validateRc(raw, candidate)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    if (dir === root) break
    dir = path.dirname(dir)
  }

  return defaultRc()
}

export async function saveRc(projectDir: string, rc: SandboxpmRc): Promise<void> {
  const filePath = path.join(projectDir, '.sandboxpmrc')
  const content = yaml.dump(rc, { lineWidth: 120 })
  await fs.writeFile(filePath, content, 'utf8')
}

const SANDBOXPM_HOME = path.join(os.homedir(), '.sandboxpm')
const GLOBAL_CONFIG_PATH = path.join(SANDBOXPM_HOME, 'config.json')

function defaultGlobalConfig(): GlobalConfig {
  return {
    storeDir: path.join(SANDBOXPM_HOME, 'store'),
    cacheDir: path.join(SANDBOXPM_HOME, 'cache'),
    reportsDir: path.join(SANDBOXPM_HOME, 'reports'),
  }
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf8')
    const raw = JSON.parse(content) as Partial<GlobalConfig>
    return { ...defaultGlobalConfig(), ...raw }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
    return defaultGlobalConfig()
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await fs.mkdir(SANDBOXPM_HOME, { recursive: true })
  const tmp = `${GLOBAL_CONFIG_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
  await fs.rename(tmp, GLOBAL_CONFIG_PATH)
}

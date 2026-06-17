import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type ToolGuidanceConfig = {
  promptSnippet?: string
  promptGuidelines?: string[]
}

export type WebToolsConfig = {
  provider?: string
  proxy?: string
  apiKeys?: Record<string, string>
  baseUrls?: Record<string, string>
  guidance?: Record<string, ToolGuidanceConfig>
}

export const CONFIG_PATH = path.join(homedir(), '.pi', 'agent', 'web-tools.json')
export const CONFIG_DIR = path.dirname(CONFIG_PATH)

const LEGACY_CACHE_CONFIG_PATH = path.join(
  homedir(),
  '.pi',
  'cache',
  'pi-web-tools',
  'config.json',
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function migrateLegacyConfig(targetPath: string) {
  if (existsSync(targetPath)) return
  if (!existsSync(LEGACY_CACHE_CONFIG_PATH)) return
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true })
    renameSync(LEGACY_CACHE_CONFIG_PATH, targetPath)
  } catch {
    // ignore — fall back to creating fresh config on next write
  }
}

let cachedConfigPath: string | undefined
let cachedConfigMtimeMs: number | undefined
let cachedConfig: WebToolsConfig = {}

export function readWebToolsConfig(configPath = CONFIG_PATH): WebToolsConfig {
  if (configPath === CONFIG_PATH) migrateLegacyConfig(configPath)

  let mtimeMs: number | undefined
  try {
    mtimeMs = statSync(configPath).mtimeMs
  } catch {
    mtimeMs = undefined
  }

  if (
    cachedConfigPath === configPath &&
    cachedConfigMtimeMs === mtimeMs
  ) {
    return cachedConfig
  }

  let parsed: WebToolsConfig = {}
  if (mtimeMs !== undefined) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
      if (isRecord(raw)) parsed = raw as WebToolsConfig
    } catch {
      parsed = {}
    }
  }

  cachedConfigPath = configPath
  cachedConfigMtimeMs = mtimeMs
  cachedConfig = parsed
  return parsed
}

export function writeWebToolsConfig(config: WebToolsConfig, configPath = CONFIG_PATH) {
  mkdirSync(path.dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  chmodSync(configPath, 0o600)
  cachedConfigPath = undefined
}

export function getConfiguredValue(
  envValue: string | undefined,
  configValue: string | undefined,
) {
  return envValue?.trim() || configValue?.trim() || undefined
}

export function applyPromptGuidance<T extends {
  name: string
  promptSnippet?: string
  promptGuidelines?: string[]
}>(tool: T, config = readWebToolsConfig()): T {
  const guidance = config.guidance?.[tool.name]
  if (!guidance) return tool

  if (typeof guidance.promptSnippet === 'string' && guidance.promptSnippet.trim()) {
    tool.promptSnippet = guidance.promptSnippet.trim()
  }

  if (
    Array.isArray(guidance.promptGuidelines) &&
    guidance.promptGuidelines.length > 0 &&
    guidance.promptGuidelines.every((item) => typeof item === 'string' && item.trim())
  ) {
    tool.promptGuidelines = guidance.promptGuidelines.map((item) => item.trim())
  }

  return tool
}

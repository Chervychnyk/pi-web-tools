import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type ToolGuidanceConfig = {
  promptSnippet?: string
  promptGuidelines?: string[]
}

export type WebToolsConfig = {
  provider?: string
  apiKeys?: Record<string, string>
  baseUrls?: Record<string, string>
  guidance?: Record<string, ToolGuidanceConfig>
}

export const CONFIG_DIR = path.join(homedir(), '.config', 'pi-web-tools')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function readWebToolsConfig(configPath = CONFIG_PATH): WebToolsConfig {
  if (!existsSync(configPath)) return {}

  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  if (!isRecord(parsed)) return {}

  return parsed as WebToolsConfig
}

export function writeWebToolsConfig(config: WebToolsConfig, configPath = CONFIG_PATH) {
  mkdirSync(path.dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  chmodSync(configPath, 0o600)
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

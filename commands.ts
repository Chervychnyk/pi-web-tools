import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { CONFIG_PATH, readWebToolsConfig, writeWebToolsConfig } from './config.ts'
import { SEARCH_PROVIDER_NAMES, type SearchProviderName } from './providers/index.ts'

const CONFIGURABLE_PROVIDERS = SEARCH_PROVIDER_NAMES.filter(
  (provider) => provider !== 'auto' && provider !== 'duckduckgo',
)

const PROVIDER_ENV: Record<string, string[]> = {
  brave: ['BRAVE_API_KEY'],
  kagi: ['KAGI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GOOGLE_CX'],
  searxng: ['SEARXNG_URL'],
}

function mask(value: string | undefined) {
  if (!value) return 'unset'
  if (value.length <= 8) return '********'
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

function renderConfig(showSecrets: boolean) {
  const config = readWebToolsConfig()
  const lines = [
    `Config path: ${CONFIG_PATH}`,
    `Provider: ${config.provider || 'auto'}`,
    '',
    'Configured keys:',
  ]

  for (const provider of CONFIGURABLE_PROVIDERS) {
    const configured = config.apiKeys?.[provider]
    lines.push(`- ${provider}: ${showSecrets ? configured || 'unset' : mask(configured)}`)
  }

  lines.push('', 'Environment:')
  for (const [provider, vars] of Object.entries(PROVIDER_ENV)) {
    lines.push(`- ${provider}: ${vars.map((name) => `${name}=${mask(process.env[name])}`).join(', ')}`)
  }

  if (config.baseUrls?.searxng) {
    lines.push('', `SearXNG URL: ${config.baseUrls.searxng}`)
  }

  return lines.join('\n')
}

export function registerWebSearchConfigCommand(pi: ExtensionAPI) {
  pi.registerCommand('web-search-config', {
    description: 'Configure pi-web-tools search provider and API keys',
    getArgumentCompletions: (prefix) => {
      return ['--show', '--show-secrets']
        .filter((item) => item.startsWith(prefix))
        .map((value) => ({ value, label: value }))
    },
    handler: async (args, ctx) => {
      if (args.includes('--show') || args.includes('--show-secrets')) {
        ctx.ui.notify(renderConfig(args.includes('--show-secrets')), 'info')
        return
      }

      if (!ctx.hasUI) {
        ctx.ui.notify('web-search-config requires interactive mode. Edit ~/.config/pi-web-tools/config.json instead.', 'error')
        return
      }

      const config = readWebToolsConfig()
      const selected = await ctx.ui.select(
        'Search provider',
        SEARCH_PROVIDER_NAMES.map((provider) => {
          const active = (config.provider || 'auto') === provider ? '✓ ' : '  '
          const configured = config.apiKeys?.[provider] || config.baseUrls?.[provider]
          return `${active}${provider}${configured ? ' (configured)' : ''}`
        }),
      )

      if (!selected) return

      const provider = selected.replace(/^✓\s*/, '').trim().split(/\s+/)[0] as SearchProviderName
      config.provider = provider
      config.apiKeys ||= {}
      config.baseUrls ||= {}

      if (provider === 'searxng') {
        const currentUrl = config.baseUrls.searxng || 'http://localhost:8080'
        const url = await ctx.ui.input('SearXNG URL', currentUrl)
        if (url) config.baseUrls.searxng = url.trim()
      } else if (provider !== 'auto' && provider !== 'duckduckgo') {
        const existing = config.apiKeys[provider]
        const value = await ctx.ui.input(
          `${provider} API key`,
          existing ? 'Press Enter to keep existing key' : 'Paste API key',
        )
        if (value?.trim()) config.apiKeys[provider] = value.trim()
      }

      writeWebToolsConfig(config)
      ctx.ui.notify(`Saved web search config to ${CONFIG_PATH}`, 'info')
    },
  })
}

import { readWebToolsConfig, getConfiguredValue, type WebToolsConfig } from '../config.ts'
import { createBraveProvider } from './brave.ts'
import { createDuckDuckGoProvider } from './duckduckgo.ts'
import { createGoogleProvider } from './google.ts'
import { createKagiProvider } from './kagi.ts'
import { MAX_SEARCH_LIMIT, clampSearchLimit } from './shared.ts'
import { createSearXngProvider } from './searxng.ts'
import type { ConcreteSearchProviderName, SearchProviderName } from './types.ts'
import { SEARCH_PROVIDER_NAMES } from './types.ts'

export { MAX_SEARCH_LIMIT, clampSearchLimit }
export { SEARCH_PROVIDER_NAMES }
export type {
  SearchProvider,
  SearchProviderName,
  SearchResultItem,
} from './types.ts'

function isProviderName(value: string): value is SearchProviderName {
  return SEARCH_PROVIDER_NAMES.includes(value as SearchProviderName)
}

function getAutoProviders(env: NodeJS.ProcessEnv, config: WebToolsConfig = readWebToolsConfig()) {
  const providers = []
  const braveKey = getConfiguredValue(env.BRAVE_API_KEY, config.apiKeys?.brave)
  const kagiKey = getConfiguredValue(env.KAGI_API_KEY, config.apiKeys?.kagi)
  const googleKey = getConfiguredValue(env.GOOGLE_API_KEY, config.apiKeys?.google)
  const googleCx = getConfiguredValue(env.GOOGLE_CX, config.apiKeys?.googleCx)
  const searxngUrl = getConfiguredValue(env.SEARXNG_URL, config.baseUrls?.searxng)

  if (braveKey) providers.push(createBraveProvider(braveKey))
  if (kagiKey) providers.push(createKagiProvider(kagiKey))
  if (googleKey && googleCx) {
    providers.push(createGoogleProvider(googleKey, googleCx))
  }
  if (searxngUrl) providers.push(createSearXngProvider(searxngUrl))
  providers.push(createDuckDuckGoProvider())

  return providers
}

function fromExplicitProvider(
  explicit: ConcreteSearchProviderName,
  env: NodeJS.ProcessEnv,
  config: WebToolsConfig = readWebToolsConfig(),
) {
  switch (explicit) {
    case 'duckduckgo':
      return createDuckDuckGoProvider()
    case 'brave': {
      const apiKey = getConfiguredValue(env.BRAVE_API_KEY, config.apiKeys?.brave)
      if (!apiKey) {
        throw new Error('BRAVE_API_KEY or apiKeys.brave is required for Brave search')
      }
      return createBraveProvider(apiKey)
    }
    case 'kagi': {
      const apiKey = getConfiguredValue(env.KAGI_API_KEY, config.apiKeys?.kagi)
      if (!apiKey) {
        throw new Error('KAGI_API_KEY or apiKeys.kagi is required for Kagi search')
      }
      return createKagiProvider(apiKey)
    }
    case 'google': {
      const apiKey = getConfiguredValue(env.GOOGLE_API_KEY, config.apiKeys?.google)
      const cx = getConfiguredValue(env.GOOGLE_CX, config.apiKeys?.googleCx)
      if (!apiKey || !cx) {
        throw new Error(
          'GOOGLE_API_KEY/GOOGLE_CX or apiKeys.google/apiKeys.googleCx are required for Google search',
        )
      }
      return createGoogleProvider(apiKey, cx)
    }
    case 'searxng': {
      const baseUrl = getConfiguredValue(env.SEARXNG_URL, config.baseUrls?.searxng)
      if (!baseUrl) {
        throw new Error('SEARXNG_URL or baseUrls.searxng is required for SearXNG search')
      }
      return createSearXngProvider(baseUrl)
    }
  }
}

export function resolveSearchProviders(
  providerName: SearchProviderName | undefined,
  env: NodeJS.ProcessEnv = process.env,
  config: WebToolsConfig = env === process.env ? readWebToolsConfig() : {},
) {
  const rawExplicit = (providerName || env.PI_WEB_SEARCH_PROVIDER || config.provider || 'auto')
    .toLowerCase()
    .trim()

  if (!isProviderName(rawExplicit)) {
    throw new Error(
      `Unknown search provider: ${rawExplicit}. Valid options: ${SEARCH_PROVIDER_NAMES.join(', ')}`,
    )
  }

  if (rawExplicit === 'auto') {
    return getAutoProviders(env, config)
  }

  return [fromExplicitProvider(rawExplicit, env, config)]
}

export function resolveSearchProvider(
  providerName: SearchProviderName | undefined,
  env: NodeJS.ProcessEnv = process.env,
  config: WebToolsConfig = env === process.env ? readWebToolsConfig() : {},
) {
  return resolveSearchProviders(providerName, env, config)[0]!
}

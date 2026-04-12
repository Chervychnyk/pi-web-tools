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
  BraveResponse,
  GoogleResponse,
  KagiResponse,
  SearchProvider,
  SearchProviderName,
  SearchResultItem,
  SearXngResponse,
} from './types.ts'

function isProviderName(value: string): value is SearchProviderName {
  return SEARCH_PROVIDER_NAMES.includes(value as SearchProviderName)
}

function getAutoProviders(env: NodeJS.ProcessEnv) {
  const providers = []

  if (env.BRAVE_API_KEY) providers.push(createBraveProvider(env.BRAVE_API_KEY))
  if (env.KAGI_API_KEY) providers.push(createKagiProvider(env.KAGI_API_KEY))
  if (env.GOOGLE_API_KEY && env.GOOGLE_CX) {
    providers.push(createGoogleProvider(env.GOOGLE_API_KEY, env.GOOGLE_CX))
  }
  if (env.SEARXNG_URL) providers.push(createSearXngProvider(env.SEARXNG_URL))
  providers.push(createDuckDuckGoProvider())

  return providers
}

function fromExplicitProvider(
  explicit: ConcreteSearchProviderName,
  env: NodeJS.ProcessEnv,
) {
  switch (explicit) {
    case 'duckduckgo':
      return createDuckDuckGoProvider()
    case 'brave':
      if (!env.BRAVE_API_KEY) {
        throw new Error('BRAVE_API_KEY is required for Brave search')
      }
      return createBraveProvider(env.BRAVE_API_KEY)
    case 'kagi':
      if (!env.KAGI_API_KEY) {
        throw new Error('KAGI_API_KEY is required for Kagi search')
      }
      return createKagiProvider(env.KAGI_API_KEY)
    case 'google':
      if (!env.GOOGLE_API_KEY || !env.GOOGLE_CX) {
        throw new Error(
          'GOOGLE_API_KEY and GOOGLE_CX are required for Google search',
        )
      }
      return createGoogleProvider(env.GOOGLE_API_KEY, env.GOOGLE_CX)
    case 'searxng':
      if (!env.SEARXNG_URL) {
        throw new Error('SEARXNG_URL is required for SearXNG search')
      }
      return createSearXngProvider(env.SEARXNG_URL)
  }
}

export function resolveSearchProviders(
  providerName: SearchProviderName | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const rawExplicit = (providerName || env.PI_WEB_SEARCH_PROVIDER || 'auto')
    .toLowerCase()
    .trim()

  if (!isProviderName(rawExplicit)) {
    throw new Error(
      `Unknown search provider: ${rawExplicit}. Valid options: ${SEARCH_PROVIDER_NAMES.join(', ')}`,
    )
  }

  if (rawExplicit === 'auto') {
    return getAutoProviders(env)
  }

  return [fromExplicitProvider(rawExplicit, env)]
}

export function resolveSearchProvider(
  providerName: SearchProviderName | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  return resolveSearchProviders(providerName, env)[0]!
}

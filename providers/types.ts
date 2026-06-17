export type SearchResultItem = {
  title: string
  url: string
  snippet: string
}

export const SEARCH_PROVIDER_NAMES = [
  'auto',
  'duckduckgo',
  'brave',
  'kagi',
  'google',
  'searxng',
] as const

export type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number]
export type ConcreteSearchProviderName = Exclude<SearchProviderName, 'auto'>

export type SearchProvider = {
  name: ConcreteSearchProviderName
  search: (
    query: string,
    limit: number,
    signal: AbortSignal,
  ) => Promise<SearchResultItem[]>
}

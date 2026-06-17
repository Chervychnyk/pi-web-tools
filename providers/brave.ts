import { createJsonSearchProvider } from './json-search.ts'
import { dedupeResults } from './shared.ts'
import type { SearchProvider } from './types.ts'

type BraveResponse = {
  web?: {
    results?: Array<{
      title?: string
      url?: string
      description?: string
      snippet?: string
    }>
  }
}

export function parseBraveResults(json: unknown, limit: number) {
  const data = json as BraveResponse
  const items = Array.isArray(data.web?.results) ? data.web.results : []
  return dedupeResults(
    items.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.description || item.snippet || '',
    })),
    limit,
  )
}

export function createBraveProvider(apiKey: string): SearchProvider {
  return createJsonSearchProvider({
    name: 'brave',
    errorLabel: 'Brave',
    buildRequest: (query, limit) => ({
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      headers: { 'X-Subscription-Token': apiKey },
    }),
    parseResponse: parseBraveResults,
  })
}

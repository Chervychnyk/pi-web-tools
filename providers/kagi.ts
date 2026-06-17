import { createJsonSearchProvider } from './json-search.ts'
import { dedupeResults } from './shared.ts'
import type { SearchProvider } from './types.ts'

type KagiResponse = {
  data?: Array<{
    title?: string
    url?: string
    snippet?: string
    description?: string
  }>
}

export function parseKagiResults(json: unknown, limit: number) {
  const data = json as KagiResponse
  const items = Array.isArray(data.data) ? data.data : []
  return dedupeResults(
    items.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.snippet || item.description || '',
    })),
    limit,
  )
}

export function createKagiProvider(apiKey: string): SearchProvider {
  return createJsonSearchProvider({
    name: 'kagi',
    errorLabel: 'Kagi',
    buildRequest: (query, limit) => ({
      url: `https://kagi.com/api/v0/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      headers: { Authorization: `Bot ${apiKey}` },
    }),
    parseResponse: parseKagiResults,
  })
}

import { createJsonSearchProvider } from './json-search.ts'
import { dedupeResults } from './shared.ts'
import type { SearchProvider } from './types.ts'

type GoogleResponse = {
  items?: Array<{
    title?: string
    link?: string
    snippet?: string
  }>
}

export function parseGoogleResults(json: unknown, limit: number) {
  const data = json as GoogleResponse
  const items = Array.isArray(data.items) ? data.items : []
  return dedupeResults(
    items.map((item) => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
    })),
    limit,
  )
}

export function createGoogleProvider(apiKey: string, cx: string): SearchProvider {
  return createJsonSearchProvider({
    name: 'google',
    errorLabel: 'Google',
    buildRequest: (query, limit) => ({
      url: `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`,
    }),
    parseResponse: parseGoogleResults,
  })
}

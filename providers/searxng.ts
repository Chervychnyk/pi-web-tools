import { createJsonSearchProvider } from './json-search.ts'
import { dedupeResults } from './shared.ts'
import type { SearchProvider } from './types.ts'

type SearXngResponse = {
  results?: Array<{
    title?: string
    url?: string
    content?: string
  }>
}

export function parseSearXngResults(json: unknown, limit: number) {
  const data = json as SearXngResponse
  const items = Array.isArray(data.results) ? data.results : []
  return dedupeResults(
    items.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
    })),
    limit,
  )
}

export function createSearXngProvider(baseUrl: string): SearchProvider {
  const root = baseUrl.replace(/\/$/, '')
  return createJsonSearchProvider({
    name: 'searxng',
    errorLabel: 'SearXNG',
    buildRequest: (query) => ({
      url: `${root}/search?q=${encodeURIComponent(query)}&format=json&language=en-US&pageno=1`,
    }),
    parseResponse: parseSearXngResults,
  })
}

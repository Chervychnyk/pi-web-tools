import { SEARCH_USER_AGENT, dedupeResults, parseJsonResponse } from './shared.ts'
import type { SearchProvider, SearXngResponse } from './types.ts'

export function parseSearXngResults(json: SearXngResponse, limit: number) {
  const items = Array.isArray(json.results) ? json.results : []
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
  return {
    name: 'searxng',
    async search(query, limit, signal) {
      const response = await fetch(
        `${root}/search?q=${encodeURIComponent(query)}&format=json&language=en-US&pageno=1`,
        {
          signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': SEARCH_USER_AGENT,
          },
        },
      )

      if (!response.ok) {
        throw new Error(
          `SearXNG search failed: ${response.status} ${response.statusText}`,
        )
      }

      return parseSearXngResults(
        await parseJsonResponse<SearXngResponse>(response),
        limit,
      )
    },
  }
}

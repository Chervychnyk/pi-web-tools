import {
  SEARCH_USER_AGENT,
  dedupeResults,
  parseJsonResponse,
} from './shared.ts'
import type { BraveResponse, SearchProvider } from './types.ts'

export function parseBraveResults(json: BraveResponse, limit: number) {
  const items = Array.isArray(json.web?.results) ? json.web.results : []
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
  return {
    name: 'brave',
    async search(query, limit, signal) {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
        {
          signal,
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': apiKey,
            'User-Agent': SEARCH_USER_AGENT,
          },
        },
      )

      if (!response.ok) {
        throw new Error(
          `Brave search failed: ${response.status} ${response.statusText}`,
        )
      }

      return parseBraveResults(
        await parseJsonResponse<BraveResponse>(response),
        limit,
      )
    },
  }
}

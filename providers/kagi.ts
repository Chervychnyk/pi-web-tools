import { SEARCH_USER_AGENT, dedupeResults, parseJsonResponse } from './shared.ts'
import type { KagiResponse, SearchProvider } from './types.ts'

export function parseKagiResults(json: KagiResponse, limit: number) {
  const items = Array.isArray(json.data) ? json.data : []
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
  return {
    name: 'kagi',
    async search(query, limit, signal) {
      const response = await fetch(
        `https://kagi.com/api/v0/search?q=${encodeURIComponent(query)}&limit=${limit}`,
        {
          signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bot ${apiKey}`,
            'User-Agent': SEARCH_USER_AGENT,
          },
        },
      )

      if (!response.ok) {
        throw new Error(
          `Kagi search failed: ${response.status} ${response.statusText}`,
        )
      }

      return parseKagiResults(await parseJsonResponse<KagiResponse>(response), limit)
    },
  }
}

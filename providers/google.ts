import { SEARCH_USER_AGENT, dedupeResults, parseJsonResponse } from './shared.ts'
import type { GoogleResponse, SearchProvider } from './types.ts'

export function parseGoogleResults(json: GoogleResponse, limit: number) {
  const items = Array.isArray(json.items) ? json.items : []
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
  return {
    name: 'google',
    async search(query, limit, signal) {
      const response = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`,
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
          `Google search failed: ${response.status} ${response.statusText}`,
        )
      }

      return parseGoogleResults(
        await parseJsonResponse<GoogleResponse>(response),
        limit,
      )
    },
  }
}

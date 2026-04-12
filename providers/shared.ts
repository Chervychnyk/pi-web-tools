import { normalizeWhitespace } from '../shared.ts'
import type { SearchResultItem } from './types.ts'

export const SEARCH_USER_AGENT = 'pi-web-search/1.1 (+https://duckduckgo.com)'
export const MAX_SEARCH_LIMIT = 20

export function clampSearchLimit(limit: number) {
  return Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT)
}

export function dedupeResults(items: SearchResultItem[], limit: number) {
  const deduped: SearchResultItem[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const title = normalizeWhitespace(item.title || '')
    const url = item.url || ''
    const snippet = normalizeWhitespace(item.snippet || '')

    if (!title || !url) continue
    const key = `${title}\u0000${url}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({ title, url, snippet })
    if (deduped.length >= limit) break
  }

  return deduped
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    throw new Error('Search provider returned invalid JSON')
  }
}

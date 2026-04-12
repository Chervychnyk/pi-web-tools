import * as cheerio from 'cheerio'
import { normalizeWhitespace } from '../shared.ts'
import { SEARCH_USER_AGENT, dedupeResults } from './shared.ts'
import type { SearchProvider } from './types.ts'

export function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const cleaned = rawUrl.replace(/&amp;/g, '&')

  try {
    const absolute = cleaned.startsWith('//') ? `https:${cleaned}` : cleaned
    const parsed = new URL(absolute, 'https://duckduckgo.com')
    const redirect = parsed.searchParams.get('uddg')
    return redirect ? decodeURIComponent(redirect) : absolute
  } catch {
    return cleaned
  }
}

export function parseDuckDuckGoResults(html: string, limit: number) {
  const $ = cheerio.load(html)
  const results: Array<{ title: string; url: string; snippet: string }> = []

  $('a.result__a').each((_, element) => {
    if (results.length >= limit) return false

    const anchor = $(element)
    const title = normalizeWhitespace(anchor.text())
    const url = unwrapDuckDuckGoUrl(anchor.attr('href') || '')
    const container = anchor.closest('.result')
    const snippet = normalizeWhitespace(
      container.find('.result__snippet').first().text() ||
        container.find('[class*="snippet"]').first().text() ||
        '',
    )

    if (!title || !url) return
    results.push({ title, url, snippet })
  })

  return dedupeResults(results, limit)
}

export function createDuckDuckGoProvider(): SearchProvider {
  return {
    name: 'duckduckgo',
    async search(query, limit, signal) {
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          signal,
          headers: {
            'User-Agent': SEARCH_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
          },
        },
      )

      if (!response.ok) {
        throw new Error(
          `DuckDuckGo search failed: ${response.status} ${response.statusText}`,
        )
      }

      return parseDuckDuckGoResults(await response.text(), limit)
    },
  }
}

import type { SearchResultItem } from './providers/index.ts'
import type { StoredSearchResponse, StoredSearchQuery } from './storage.ts'
import { truncateText } from './shared.ts'

export type SearchTextFormatOptions = {
  queryLimit?: number
  resultLimit?: number
  snippetMaxChars?: number
  forceHeading?: boolean
}

type SearchTextQuery = Pick<StoredSearchQuery, 'query' | 'results' | 'count'>

function formatSearchResultItem(
  result: SearchResultItem,
  index: number,
  snippetMaxChars: number | undefined,
) {
  const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`]
  const snippet = result.snippet?.trim()
  if (snippet) {
    lines.push(
      `   ${snippetMaxChars ? truncateText(snippet, snippetMaxChars) : snippet}`,
    )
  }
  return lines.join('\n')
}

export function formatSearchQueryText(
  queryResult: SearchTextQuery,
  options: SearchTextFormatOptions = {},
) {
  const {
    resultLimit = queryResult.results.length,
    snippetMaxChars,
    forceHeading = false,
  } = options

  const visibleResults = queryResult.results.slice(0, resultLimit)
  const body = visibleResults.length
    ? visibleResults
        .map((result, index) =>
          formatSearchResultItem(result, index, snippetMaxChars),
        )
        .join('\n\n')
    : `No results found for: ${queryResult.query}`

  const hiddenResults = Math.max(queryResult.results.length - visibleResults.length, 0)
  const suffix =
    hiddenResults > 0
      ? `${body}\n\n... ${hiddenResults} more result${hiddenResults === 1 ? '' : 's'}`
      : body

  return forceHeading ? `## Query: ${queryResult.query}\n\n${suffix}` : suffix
}

export function formatSearchResponseText(
  queryResults: SearchTextQuery[],
  options: SearchTextFormatOptions = {},
) {
  const { queryLimit = queryResults.length } = options
  const visibleQueries = queryResults.slice(0, queryLimit)
  const forceHeading = options.forceHeading ?? visibleQueries.length > 1
  const sections = visibleQueries.map((queryResult) =>
    formatSearchQueryText(queryResult, {
      ...options,
      forceHeading,
    }),
  )

  if (!sections.length) return ''

  let text = sections.join(forceHeading ? '\n\n---\n\n' : '\n\n')
  const hiddenQueries = Math.max(queryResults.length - visibleQueries.length, 0)
  if (hiddenQueries > 0) {
    text = [
      text,
      '---',
      `Showing ${visibleQueries.length} of ${queryResults.length} queries. Use get_web_content to inspect the full stored response.`,
    ].join('\n\n')
  }

  return text
}

export function formatStoredSearchResponseText(
  stored: StoredSearchResponse,
  selection?: {
    query?: string
    queryIndex?: number
  },
) {
  if (selection?.queryIndex !== undefined) {
    const selected = stored.queryResults[selection.queryIndex]
    if (!selected) {
      throw new Error(
        `queryIndex ${selection.queryIndex} is out of range for responseId ${stored.responseId}`,
      )
    }

    return {
      text: formatSearchQueryText(selected, {
        forceHeading: stored.queryResults.length > 1,
      }),
      selectedQuery: selected.query,
    }
  }

  if (selection?.query) {
    const selected = stored.queryResults.find((item) => item.query === selection.query)
    if (!selected) {
      throw new Error(
        `Query not found in stored response: ${selection.query}. Available queries: ${stored.queries.join(', ')}`,
      )
    }

    return {
      text: formatSearchQueryText(selected, {
        forceHeading: stored.queryResults.length > 1,
      }),
      selectedQuery: selected.query,
    }
  }

  return {
    text: formatSearchResponseText(stored.queryResults),
    selectedQuery: undefined,
  }
}

import { formatStoredSearchResponseText } from './search-format.ts'
import { truncateForModel } from './utils/truncate.ts'
import {
  DEFAULT_CONTENT_SLICE_LIMIT,
  getStoredWebResponse,
  sliceStoredText,
  type StoredSearchQuery,
  type StoredWebResponse,
} from './storage.ts'

export type StoredContentDetails = {
  responseId: string
  kind: StoredWebResponse['kind']
  selectedQuery?: string
  selectedBy?: 'query' | 'queryIndex'
  queryCount?: number
  requestUrl?: string
  finalUrl?: string
  format?: string
  title?: string | null
  requestedProvider?: string
  resultCount?: number
  queryIndex?: number
  offset: number
  limit: number
  returnedLines: number
  totalLines: number
  hasMore: boolean
  nextOffset?: number
  truncated: boolean
  tempFile?: string
  charLimited: boolean
  maxChars?: number
  originalChars: number
}

type SelectedStoredSearch = {
  text: string
  selectedQuery?: StoredSearchQuery['query']
  queryIndex?: number
}

function findSelectedQueryIndex(
  stored: Extract<StoredWebResponse, { kind: 'search' }>,
  selectedQuery: string | undefined,
  queryIndex: number | undefined,
) {
  if (queryIndex !== undefined) return queryIndex
  if (!selectedQuery) return undefined
  const foundIndex = stored.queryResults.findIndex((item) => item.query === selectedQuery)
  return foundIndex >= 0 ? foundIndex : undefined
}

function resolveSearchQuerySelection(
  stored: Extract<StoredWebResponse, { kind: 'search' }>,
  query: string | undefined,
  queryIndex: number | undefined,
): SelectedStoredSearch {
  if (query && queryIndex !== undefined) {
    throw new Error('Use either query or queryIndex, not both')
  }

  const selected = formatStoredSearchResponseText(stored, { query, queryIndex })
  return {
    ...selected,
    queryIndex: findSelectedQueryIndex(stored, selected.selectedQuery, queryIndex),
  }
}

function renderFetchContentContext(details: StoredContentDetails) {
  const sourceUrl = details.finalUrl || details.requestUrl || 'unknown'
  const includeRequestUrl =
    details.requestUrl && details.finalUrl && details.requestUrl !== details.finalUrl
  const lines = [`Source URL: ${sourceUrl}`]

  if (includeRequestUrl) lines.push(`Requested URL: ${details.requestUrl}`)
  if (details.title) lines.push(`Title: ${details.title}`)
  if (details.format) lines.push(`Format: ${details.format}`)
  return lines.join('\n')
}

function getSearchContextLabel(details: StoredContentDetails) {
  if (details.selectedQuery) return `Search query: ${details.selectedQuery}`
  if (details.queryCount) return `Search response: ${details.queryCount} queries`
  return undefined
}

function renderSearchContentContext(details: StoredContentDetails) {
  const lines: string[] = []
  const searchLabel = getSearchContextLabel(details)

  if (searchLabel) lines.push(searchLabel)
  if (details.requestedProvider) lines.push(`Requested provider: ${details.requestedProvider}`)
  if (details.resultCount !== undefined) lines.push(`Result count: ${details.resultCount}`)
  if (details.queryIndex !== undefined) lines.push(`Query index: ${details.queryIndex}`)
  return lines.length ? lines.join('\n') : undefined
}

function renderContentContext(details: StoredContentDetails) {
  if (details.kind === 'fetch') return renderFetchContentContext(details)
  return renderSearchContentContext(details)
}

function renderContinuationHint(details: StoredContentDetails) {
  if (!details.hasMore || !details.nextOffset) return undefined

  let queryArgs = ''
  if (details.selectedBy === 'queryIndex' && details.queryIndex !== undefined) {
    queryArgs = `, queryIndex: ${details.queryIndex}`
  } else if (details.selectedQuery) {
    queryArgs = `, query: ${JSON.stringify(details.selectedQuery)}`
  }

  return [
    '---',
    `Showing lines ${details.offset}-${details.offset + details.returnedLines - 1} of ${details.totalLines}.`,
    `Continue with: get_web_content({ responseId: ${JSON.stringify(details.responseId)}${queryArgs}, offset: ${details.nextOffset}, limit: ${details.limit} })`,
  ].join('\n')
}

export function readStoredContent(options: {
  responseId: string
  query?: string
  queryIndex?: number
  offset?: number
  limit?: number
  maxChars?: number
  loadStoredResponse?: typeof getStoredWebResponse
}) {
  const {
    responseId,
    query,
    queryIndex,
    offset = 1,
    limit = DEFAULT_CONTENT_SLICE_LIMIT,
    maxChars,
    loadStoredResponse = getStoredWebResponse,
  } = options

  const stored = loadStoredResponse(responseId)
  if (!stored) {
    throw new Error(`No stored web content found for responseId: ${responseId}`)
  }

  let text: string
  let selectedQuery: string | undefined
  let selectedQueryIndex: number | undefined
  let selectedBy: StoredContentDetails['selectedBy']

  if (stored.kind === 'search') {
    const selected = resolveSearchQuerySelection(stored, query, queryIndex)
    text = selected.text
    selectedQuery = selected.selectedQuery
    selectedQueryIndex = selected.queryIndex
    if (queryIndex !== undefined) selectedBy = 'queryIndex'
    else if (query) selectedBy = 'query'
  } else {
    if (query || queryIndex !== undefined) {
      throw new Error(
        'query and queryIndex are only supported for stored web_search responses',
      )
    }
    text = stored.messageText
  }

  const slice = sliceStoredText(text, offset, limit)
  const isSearch = stored.kind === 'search'
  const isFetch = stored.kind === 'fetch'
  const selectedSearchQuery =
    isSearch && selectedQueryIndex !== undefined
      ? stored.queryResults[selectedQueryIndex]
      : undefined
  let searchResultCount: number | undefined
  if (selectedSearchQuery) {
    searchResultCount = selectedSearchQuery.count
  } else if (isSearch) {
    searchResultCount = stored.queryResults.reduce((total, item) => total + item.count, 0)
  }

  const details: StoredContentDetails = {
    responseId,
    kind: stored.kind,
    selectedQuery,
    selectedBy,
    ...(isSearch
      ? {
          queryCount: stored.queryResults.length,
          requestedProvider: stored.requestedProvider,
          resultCount: searchResultCount,
          queryIndex: selectedQueryIndex,
        }
      : {}),
    ...(isFetch
      ? {
          requestUrl: stored.requestUrl,
          finalUrl: stored.finalUrl,
          format: stored.format,
          title: stored.title,
        }
      : {}),
    offset: slice.offset,
    limit: slice.limit,
    returnedLines: slice.returnedLines,
    totalLines: slice.totalLines,
    hasMore: slice.hasMore,
    nextOffset: slice.nextOffset,
    truncated: false,
    tempFile: undefined,
    charLimited: false,
    maxChars: undefined,
    originalChars: 0,
  }

  const messageParts = [renderContentContext(details), slice.text].filter(
    (part): part is string => Boolean(part),
  )
  const continuationHint = renderContinuationHint(details)
  if (continuationHint) messageParts.push(continuationHint)

  const output = truncateForModel(messageParts.join('\n\n'), '.txt', maxChars)

  return {
    content: [{ type: 'text' as const, text: output.text }],
    details: {
      ...details,
      truncated: output.truncated,
      tempFile: output.tempFile,
      charLimited: output.charLimited,
      maxChars: output.maxChars,
      originalChars: output.originalChars,
    },
  }
}

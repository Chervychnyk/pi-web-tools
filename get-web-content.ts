import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from 'typebox'
import { formatStoredSearchResponseText } from './search-format.ts'
import { renderBadges, renderToolCallHeader, truncateForModel, truncateText } from './shared.ts'
import {
  DEFAULT_CONTENT_SLICE_LIMIT,
  getStoredWebResponse,
  MAX_CONTENT_SLICE_LIMIT,
  sliceStoredText,
  type StoredSearchQuery,
  type StoredWebResponse,
} from './storage.ts'

export type GetWebContentDetails = {
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

  const selected = formatStoredSearchResponseText(stored, {
    query,
    queryIndex,
  })
  return {
    ...selected,
    queryIndex: findSelectedQueryIndex(stored, selected.selectedQuery, queryIndex),
  }
}

function renderFetchContentContext(details: GetWebContentDetails) {
  const sourceUrl = details.finalUrl || details.requestUrl || 'unknown'
  const includeRequestUrl =
    details.requestUrl && details.finalUrl && details.requestUrl !== details.finalUrl
  const lines = [`Source URL: ${sourceUrl}`]

  if (includeRequestUrl) lines.push(`Requested URL: ${details.requestUrl}`)
  if (details.title) lines.push(`Title: ${details.title}`)
  if (details.format) lines.push(`Format: ${details.format}`)
  return lines.join('\n')
}

function getSearchContextLabel(details: GetWebContentDetails) {
  if (details.selectedQuery) return `Search query: ${details.selectedQuery}`
  if (details.queryCount) return `Search response: ${details.queryCount} queries`
  return undefined
}

function renderSearchContentContext(details: GetWebContentDetails) {
  const lines: string[] = []
  const searchLabel = getSearchContextLabel(details)

  if (searchLabel) lines.push(searchLabel)
  if (details.requestedProvider) lines.push(`Requested provider: ${details.requestedProvider}`)
  if (details.resultCount !== undefined) lines.push(`Result count: ${details.resultCount}`)
  if (details.queryIndex !== undefined) lines.push(`Query index: ${details.queryIndex}`)
  return lines.length ? lines.join('\n') : undefined
}

function renderContentContext(details: GetWebContentDetails) {
  if (details.kind === 'fetch') return renderFetchContentContext(details)
  return renderSearchContentContext(details)
}

function renderContinuationHint(details: GetWebContentDetails) {
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

export type GetWebContentDependencies = {
  loadStoredResponse: typeof getStoredWebResponse
}

export function createGetWebContentTool(
  deps: Partial<GetWebContentDependencies> = {},
) {
  const loadStoredResponse = deps.loadStoredResponse || getStoredWebResponse

  return {
    name: 'get_web_content',
    label: 'Get Web Content',
    description:
      'Retrieve stored full content from a previous web_search or web_fetch response by responseId.',
    promptSnippet:
      'Retrieve stored full content from an earlier web_search or web_fetch response',
    promptGuidelines: [
      'Use this tool when a prior web_search or web_fetch response provided a responseId and you need the full stored content.',
      'For multi-query searches, optionally select a specific query with query or queryIndex.',
      `Use offset and limit to page through long content. Default limit is ${DEFAULT_CONTENT_SLICE_LIMIT} lines.`,
    ],
    parameters: Type.Object({
      responseId: Type.String({
        description: 'Stored response identifier returned by web_search or web_fetch',
      }),
      query: Type.Optional(
        Type.String({
          description:
            'Optional exact query string from a prior multi-query web_search response.',
        }),
      ),
      queryIndex: Type.Optional(
        Type.Number({
          description:
            'Optional zero-based query index from a prior multi-query web_search response.',
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: 'Line offset to start from (1-indexed). Defaults to 1.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum lines to return (default: ${DEFAULT_CONTENT_SLICE_LIMIT}, max: ${MAX_CONTENT_SLICE_LIMIT}).`,
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          description:
            'Optional hard cap for retrieved output characters before normal truncation is applied.',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const responseId = params.responseId.trim()
      const query = params.query?.trim() || undefined
      const queryIndex = params.queryIndex
      const offset = params.offset ?? 1
      const limit = params.limit ?? DEFAULT_CONTENT_SLICE_LIMIT
      const maxChars = params.maxChars

      if (!responseId) throw new Error('responseId cannot be empty')
      if (
        maxChars !== undefined &&
        (!Number.isInteger(maxChars) || maxChars <= 0)
      ) {
        throw new Error(`Invalid maxChars: ${maxChars}`)
      }

      const stored = loadStoredResponse(responseId)
      if (!stored) {
        throw new Error(`No stored web content found for responseId: ${responseId}`)
      }

      let text: string
      let selectedQuery: string | undefined
      let selectedQueryIndex: number | undefined
      let selectedBy: GetWebContentDetails['selectedBy']

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
      const searchDetails: Partial<GetWebContentDetails> = {}
      if (isSearch) {
        searchDetails.queryCount = stored.queryResults.length
        searchDetails.requestedProvider = stored.requestedProvider
        searchDetails.resultCount = searchResultCount
        searchDetails.queryIndex = selectedQueryIndex
      }

      const fetchDetails: Partial<GetWebContentDetails> = {}
      if (isFetch) {
        fetchDetails.requestUrl = stored.requestUrl
        fetchDetails.finalUrl = stored.finalUrl
        fetchDetails.format = stored.format
        fetchDetails.title = stored.title
      }
      const details: GetWebContentDetails = {
        responseId,
        kind: stored.kind,
        selectedQuery,
        selectedBy,
        ...searchDetails,
        ...fetchDetails,
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
        content: [{ type: 'text', text: output.text }],
        details: {
          ...details,
          truncated: output.truncated,
          tempFile: output.tempFile,
          charLimited: output.charLimited,
          maxChars: output.maxChars,
          originalChars: output.originalChars,
        },
      }
    },
    renderCall(args, theme) {
      const parts: string[] = []
      if (args.query) parts.push(`query=${truncateText(args.query, 36)}`)
      if (args.queryIndex !== undefined)
        parts.push(`queryIndex=${args.queryIndex}`)
      if (args.offset) parts.push(`offset=${args.offset}`)
      if (args.limit) parts.push(`limit=${args.limit}`)
      return renderToolCallHeader('get_web_content', args.responseId, 48, parts, theme)
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Loading stored content...'), 0, 0)
      }

      const details = (result.details || {}) as GetWebContentDetails
      let text = theme.fg(
        'success',
        `${details.kind} content ${details.returnedLines}/${details.totalLines} lines`,
      )

      text += renderBadges(theme, {
        truncated: details.truncated,
        charLimited: details.charLimited,
      })

      if (details.selectedQuery) {
        text += ` ${theme.fg('accent', truncateText(details.selectedQuery, 48))}`
      }
      text += ` ${theme.fg('muted', details.responseId)}`

      if (details.hasMore && details.nextOffset) {
        text += ` ${theme.fg('warning', `next=${details.nextOffset}`)}`
      }

      if (expanded) {
        if (details.requestUrl) {
          text += `\n${theme.fg('dim', `Request URL: ${details.requestUrl}`)}`
        }
        if (details.finalUrl) {
          text += `\n${theme.fg('dim', `Final URL: ${details.finalUrl}`)}`
        }
        if (details.format) {
          text += `\n${theme.fg('dim', `Format: ${details.format}`)}`
        }
        if (details.title) {
          text += `\n${theme.fg('accent', `Title: ${details.title}`)}`
        }
        if (details.queryCount && !details.selectedQuery) {
          text += `\n${theme.fg('dim', `Queries: ${details.queryCount}`)}`
        }
        if (details.tempFile) {
          text += `\n${theme.fg('muted', `Full output: ${details.tempFile}`)}`
        }
      }

      return new Text(text, 0, 0)
    },
  }
}

export function registerGetWebContentTool(pi: ExtensionAPI) {
  pi.registerTool(createGetWebContentTool())
}

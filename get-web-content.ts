import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'
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
  queryCount?: number
  requestUrl?: string
  finalUrl?: string
  format?: string
  title?: string | null
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

function resolveSearchQuerySelection(
  stored: Extract<StoredWebResponse, { kind: 'search' }>,
  query: string | undefined,
  queryIndex: number | undefined,
): { text: string; selectedQuery?: StoredSearchQuery['query'] } {
  if (query && queryIndex !== undefined) {
    throw new Error('Use either query or queryIndex, not both')
  }

  return formatStoredSearchResponseText(stored, {
    query,
    queryIndex,
  })
}

function renderContinuationHint(details: GetWebContentDetails) {
  if (!details.hasMore || !details.nextOffset) return undefined

  const queryArgs = details.selectedQuery
    ? `, query: ${JSON.stringify(details.selectedQuery)}`
    : ''

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

      if (stored.kind === 'search') {
        const selected = resolveSearchQuerySelection(stored, query, queryIndex)
        text = selected.text
        selectedQuery = selected.selectedQuery
      } else {
        if (query || queryIndex !== undefined) {
          throw new Error(
            'query and queryIndex are only supported for stored web_search responses',
          )
        }
        text = stored.messageText
      }

      const slice = sliceStoredText(text, offset, limit)
      const details: GetWebContentDetails = {
        responseId,
        kind: stored.kind,
        selectedQuery,
        queryCount: stored.kind === 'search' ? stored.queryResults.length : undefined,
        requestUrl: stored.kind === 'fetch' ? stored.requestUrl : undefined,
        finalUrl: stored.kind === 'fetch' ? stored.finalUrl : undefined,
        format: stored.kind === 'fetch' ? stored.format : undefined,
        title: stored.kind === 'fetch' ? stored.title : undefined,
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

      const messageParts = [slice.text]
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

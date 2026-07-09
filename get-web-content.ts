import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from 'typebox'
import { truncateText } from './utils/truncate.ts'
import { readStoredContent, type StoredContentDetails } from './stored-response-reader.ts'
import { renderBadges, renderToolCallHeader } from './utils/ui.ts'
import {
  DEFAULT_CONTENT_SLICE_LIMIT,
  getStoredWebResponse,
  MAX_CONTENT_SLICE_LIMIT,
} from './storage.ts'

export type GetWebContentDetails = StoredContentDetails


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

      return readStoredContent({
        responseId,
        query,
        queryIndex,
        offset,
        limit,
        maxChars,
        loadStoredResponse,
      })
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
      const sep = theme.fg('dim', ' · ')
      let text = theme.fg('success', '✓ ')
      text += theme.fg('success', details.kind)
      text += sep
      text += theme.fg('dim', `${details.returnedLines}/${details.totalLines} lines`)

      text += renderBadges(theme, {
        truncated: details.truncated,
        charLimited: details.charLimited,
      })

      if (details.selectedQuery) {
        text += sep + theme.fg('accent', truncateText(details.selectedQuery, 48))
      }
      text += sep + theme.fg('muted', details.responseId)

      if (details.hasMore && details.nextOffset) {
        text += sep + theme.fg('warning', `next=${details.nextOffset}`)
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

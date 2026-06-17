import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { StringEnum } from '@mariozechner/pi-ai'
import { Text } from '@mariozechner/pi-tui'
import { Type } from 'typebox'
import { pluralize } from './shared.ts'
import { truncateText } from './utils/truncate.ts'
import { renderToolCallHeader } from './utils/ui.ts'
import { listStoredWebResponses, type StoredWebResponse } from './storage.ts'

export type ListedWebContentItem = {
  responseId: string
  kind: StoredWebResponse['kind']
  source: string
  extra: string
  createdAt: string
}

export type ListWebContentDetails = {
  count: number
  limit: number
  kind?: StoredWebResponse['kind']
  items: ListedWebContentItem[]
}

function countSearchResults(item: Extract<StoredWebResponse, { kind: 'search' }>) {
  return item.resultCount ?? item.queryResults.reduce((total, query) => total + query.count, 0)
}

function summarizeFetchResponse(item: Extract<StoredWebResponse, { kind: 'fetch' }>) {
  const extra = [
    item.title,
    item.format,
    item.lineCount ? `${item.lineCount} lines` : undefined,
  ].filter(Boolean)

  return {
    source: item.finalUrl || item.requestUrl,
    extra: extra.join(' · '),
  }
}

function summarizeSearchResponse(item: Extract<StoredWebResponse, { kind: 'search' }>) {
  return {
    source: item.queries.join(' | '),
    extra: [
      pluralize(item.queries.length, 'query', 'queries'),
      pluralize(countSearchResults(item), 'result'),
      item.requestedProvider,
    ].join(' · '),
  }
}

function summarizeStoredResponse(item: StoredWebResponse) {
  let summary: { source: string; extra: string }
  if (item.kind === 'fetch') {
    summary = summarizeFetchResponse(item)
  } else {
    summary = summarizeSearchResponse(item)
  }

  return {
    responseId: item.responseId,
    kind: item.kind,
    source: summary.source,
    extra: summary.extra,
    createdAt: item.createdAt,
  } satisfies ListedWebContentItem
}

function formatStoredResponses(items: ListedWebContentItem[]) {
  if (!items.length) return 'No stored web content found.'

  const lines = ['Stored web content:', '']
  for (const [index, item] of items.entries()) {
    lines.push(`${index + 1}. ${item.responseId} — ${item.kind}`)
    lines.push(`   Source: ${item.source}`)
    if (item.extra) lines.push(`   ${item.extra}`)
    lines.push(`   Created: ${item.createdAt}`)
    lines.push(`   Retrieve: get_web_content({ responseId: ${JSON.stringify(item.responseId)} })`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

export function createListWebContentTool(
  deps: { listResponses?: typeof listStoredWebResponses } = {},
) {
  const listResponses = deps.listResponses || listStoredWebResponses

  return {
    name: 'list_web_content',
    label: 'List Web Content',
    description:
      'List recent stored web_search and web_fetch responses with responseIds and source context.',
    promptSnippet:
      'List recent stored web content responseIds and their related URLs or queries',
    promptGuidelines: [
      'Use this tool when you have a responseId but need to recover what URL or query it came from.',
      'Use get_web_content with a listed responseId to retrieve the stored content.',
    ],
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ description: 'Maximum stored responses to show. Defaults to 20.' }),
      ),
      kind: Type.Optional(
        StringEnum(['fetch', 'search'], {
          description: 'Optional filter by stored response kind.',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const limit = params.limit ?? 20
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`Invalid limit: ${limit}`)
      }
      const kind = params.kind as StoredWebResponse['kind'] | undefined
      const items = listResponses({ limit, kind }).map(summarizeStoredResponse)
      return {
        content: [{ type: 'text' as const, text: formatStoredResponses(items) }],
        details: {
          count: items.length,
          limit,
          kind,
          items,
        } satisfies ListWebContentDetails,
      }
    },
    renderCall(args, theme) {
      const parts: string[] = []
      if (args.kind) parts.push(`kind=${args.kind}`)
      if (args.limit) parts.push(`limit=${args.limit}`)
      return renderToolCallHeader('list_web_content', 'recent stored responses', 48, parts, theme)
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Listing stored content...'), 0, 0)
      }
      const details = (result.details || {}) as ListWebContentDetails
      let text = details.count > 0
        ? theme.fg('success', `${details.count} stored responses`)
        : theme.fg('dim', 'No stored responses')
      if (details.kind) text += ` ${theme.fg('muted', `kind=${details.kind}`)}`
      const first = details.items?.[0]
      if (first) {
        text += `\n${theme.fg('muted', `${first.responseId}: ${truncateText(first.source, 100)}`)}`
      }
      return new Text(text, 0, 0)
    },
  }
}

export function registerListWebContentTool(pi: ExtensionAPI) {
  pi.registerTool(createListWebContentTool())
}

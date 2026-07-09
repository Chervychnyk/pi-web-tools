import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { StringEnum } from '@mariozechner/pi-ai'
import { Text } from '@mariozechner/pi-tui'
import { Type } from 'typebox'
import { applyPromptGuidance } from './config.ts'
import { formatSearchResponseText } from './search-format.ts'
import { executeSearchBatch, type SearchAttempt, type SearchQueryDetails } from './search-runner.ts'
import { appendStoredResponseNote } from './shared.ts'
import { DEFAULT_TIMEOUT, createAbortController } from './utils/abort.ts'
import { buildCacheKey, getCachedValue, setCachedValue } from './utils/cache.ts'
import { truncateForModel, truncateText } from './utils/truncate.ts'
import { formatDuration, renderBadges, renderToolCallHeader } from './utils/ui.ts'
import {
  MAX_SEARCH_LIMIT,
  SEARCH_PROVIDER_NAMES,
  clampSearchLimit,
  type SearchProvider,
  type SearchResultItem,
  resolveSearchProviders,
} from './providers/index.ts'
import { tryStoreWebResponse } from './storage.ts'

const DEFAULT_SEARCH_LIMIT = 5
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_BATCH_QUERIES = 6
const SINGLE_QUERY_PREVIEW_LIMIT = 5
const MULTI_QUERY_PREVIEW_LIMIT = 3
const SEARCH_PREVIEW_SNIPPET_MAX_CHARS = 160
const MAX_CACHED_SEARCH_PREVIEW_CHARS = 100_000

type SearchProviderSummary = SearchProvider['name'] | 'mixed'

export type SearchDetails = {
  responseId?: string
  query?: string
  queries: string[]
  queryResults: SearchQueryDetails[]
  count: number
  results: SearchResultItem[]
  provider: SearchProviderSummary
  truncated: boolean
  tempFile?: string
  totalBytes: number
  totalLines: number
  maxChars?: number
  charLimited: boolean
  originalChars: number
  requestedProvider: string
  attempts: SearchAttempt[]
  fallbackUsed: boolean
  durationMs: number
  aborted?: boolean
  cached?: boolean
  cacheAgeMs?: number
}

export type WebSearchDependencies = {
  resolveProviders: typeof resolveSearchProviders
  storeResponse: typeof tryStoreWebResponse
}

function normalizeSearchQueries(
  query: string | undefined,
  queries: string[] | undefined,
) {
  const normalizedQuery = query?.trim()
  const normalizedQueries = (queries || [])
    .map((item) => item.trim())
    .filter(Boolean)

  if (normalizedQuery && normalizedQueries.length) {
    throw new Error('Use either query or queries, not both')
  }

  const finalQueries = normalizedQuery
    ? [normalizedQuery]
    : normalizedQueries

  if (!finalQueries.length) {
    throw new Error('Search query cannot be empty')
  }

  if (finalQueries.length > MAX_BATCH_QUERIES) {
    throw new Error(
      `Too many queries: ${finalQueries.length}. Maximum supported batch size is ${MAX_BATCH_QUERIES}`,
    )
  }

  return finalQueries
}

function summarizeProvider(queryResults: SearchQueryDetails[]): SearchProviderSummary {
  const providers = [...new Set(queryResults.map((item) => item.provider))]
  return providers.length === 1 ? providers[0]! : 'mixed'
}

function buildSearchPreview(queryResults: SearchQueryDetails[]) {
  return formatSearchResponseText(queryResults, {
    resultLimit:
      queryResults.length > 1
        ? MULTI_QUERY_PREVIEW_LIMIT
        : SINGLE_QUERY_PREVIEW_LIMIT,
    snippetMaxChars: SEARCH_PREVIEW_SNIPPET_MAX_CHARS,
  })
}

type SearchCacheEntry = {
  queries: string[]
  queryResults: SearchQueryDetails[]
  requestedProvider: string
  responseId?: string
  durationMs: number
}

function buildSearchResponse(options: {
  queries: string[]
  queryResults: SearchQueryDetails[]
  requestedProvider: string
  maxChars?: number
  responseId?: string
  durationMs: number
  cached: boolean
  cacheAgeMs: number
}) {
  const {
    queries,
    queryResults,
    requestedProvider,
    maxChars,
    responseId,
    durationMs,
    cached,
    cacheAgeMs,
  } = options
  const previewText = buildSearchPreview(queryResults)
  const output = truncateForModel(previewText, '.txt', maxChars)
  const flattenedResults = queryResults.flatMap((item) => item.results)
  const flattenedAttempts = queryResults.flatMap((item) => item.attempts)
  const storedResponseSource =
    queries.length === 1 ? queries[0] : `${queries.length} queries`

  return {
    content: [
      {
        type: 'text' as const,
        text: appendStoredResponseNote(output.text, responseId, 'get_web_content', {
          source: storedResponseSource,
          label: 'Search',
        }),
      },
    ],
    details: {
      responseId,
      query: queries.length === 1 ? queries[0] : undefined,
      queries,
      queryResults,
      count: flattenedResults.length,
      results: flattenedResults,
      provider: summarizeProvider(queryResults),
      truncated: output.truncated,
      tempFile: output.tempFile,
      totalBytes: output.totalBytes,
      totalLines: output.totalLines,
      maxChars: output.maxChars,
      charLimited: output.charLimited,
      originalChars: output.originalChars,
      requestedProvider,
      attempts: flattenedAttempts,
      fallbackUsed: queryResults.some((item) => item.fallbackUsed),
      durationMs,
      aborted: false,
      cached,
      cacheAgeMs,
    } satisfies SearchDetails,
  }
}

export function createWebSearchTool(
  deps: Partial<WebSearchDependencies> = {},
) {
  const resolveProviders = deps.resolveProviders || resolveSearchProviders
  const storeResponse = deps.storeResponse || tryStoreWebResponse

  return applyPromptGuidance({
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for current information using configurable providers. Supports one query or a small batch via queries.',
    promptSnippet:
      'Search the web for current information and documentation results',
    promptGuidelines: [
      'Use this tool when you need current information from the web before citing or fetching a page.',
      'Use queries for a small batch of distinct search angles when broader research is needed.',
      'Use web_fetch after this when you need the full contents of a specific result, or get_web_content when a stored responseId is returned.',
      'Supports provider selection via parameter or environment variables; defaults to auto-detection.',
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Single search query' })),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            `Small batch of search queries (max ${MAX_BATCH_QUERIES}). Use instead of query.`,
        }),
      ),
      provider: Type.Optional(
        StringEnum(SEARCH_PROVIDER_NAMES, {
          description:
            'Optional provider: auto, duckduckgo, brave, kagi, google, searxng. Defaults to auto.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum number of results to return per query (default: ${DEFAULT_SEARCH_LIMIT}, max: ${MAX_SEARCH_LIMIT})`,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT})`,
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          description:
            'Optional hard cap for formatted output characters before normal truncation is applied.',
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description: 'Bypass cached search results and force a fresh provider request.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const queries = normalizeSearchQueries(params.query, params.queries)
      const requestedLimit = params.limit ?? DEFAULT_SEARCH_LIMIT
      const limit = clampSearchLimit(requestedLimit)
      const timeoutMs = params.timeout ?? DEFAULT_TIMEOUT
      const maxChars = params.maxChars
      const requestedProvider = (
        params.provider || process.env.PI_WEB_SEARCH_PROVIDER || 'auto'
      )
        .toLowerCase()
        .trim()
      const providers = resolveProviders(params.provider)
      const refresh = params.refresh ?? false

      if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
        throw new Error(`Invalid result limit: ${requestedLimit}`)
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`Invalid timeout: ${timeoutMs}`)
      }
      if (
        maxChars !== undefined &&
        (!Number.isInteger(maxChars) || maxChars <= 0)
      ) {
        throw new Error(`Invalid maxChars: ${maxChars}`)
      }

      const cacheKey = buildCacheKey({
        tool: 'web_search',
        queries,
        requestedProvider,
        providers: providers.map((provider) => provider.name),
        limit,
      })

      if (!refresh) {
        const cached = getCachedValue<SearchCacheEntry>(cacheKey)
        if (cached) {
          const response = buildSearchResponse({
            ...cached.value,
            maxChars,
            cached: true,
            cacheAgeMs: cached.ageMs,
          })
          onUpdate?.({
            content: [
              {
                type: 'text',
                text:
                  queries.length === 1
                    ? `Using cached ${response.details.provider} results for: ${queries[0]}`
                    : `Using cached results for ${queries.length} queries`,
              },
            ],
          })
          return response
        }
      }

      onUpdate?.({
        content: [
          {
            type: 'text',
            text:
              queries.length === 1
                ? `Searching ${providers[0]!.name} for: ${queries[0]}`
                : `Searching ${queries.length} queries starting with ${providers[0]!.name}...`,
          },
        ],
      })

      const { controller, cleanup, rethrowIfAbort } = createAbortController(
        timeoutMs,
        signal,
      )
      const startedAt = Date.now()

      try {
        const queryResults = await executeSearchBatch({
          queries,
          providers,
          limit,
          controller,
          onUpdate,
        })

        const previewText = buildSearchPreview(queryResults)
        const stored = storeResponse({
          kind: 'search',
          requestedProvider,
          queries,
          messageText: previewText,
          sourceTool: 'web_search',
          queryResults: queryResults.map((item) => ({
            query: item.query,
            provider: item.provider,
            count: item.count,
            results: item.results,
            attempts: item.attempts,
            fallbackUsed: item.fallbackUsed,
            durationMs: item.durationMs,
          })),
        })
        const durationMs = Date.now() - startedAt
        const response = buildSearchResponse({
          queries,
          queryResults,
          requestedProvider,
          maxChars,
          responseId: stored?.responseId,
          durationMs,
          cached: false,
          cacheAgeMs: 0,
        })

        if (previewText.length <= MAX_CACHED_SEARCH_PREVIEW_CHARS) {
          setCachedValue(
            cacheKey,
            {
              queries,
              queryResults,
              requestedProvider,
              responseId: stored?.responseId,
              durationMs,
            } satisfies SearchCacheEntry,
            SEARCH_CACHE_TTL_MS,
          )
        }
        return response
      } catch (error) {
        rethrowIfAbort(error, 'Search request')
      } finally {
        cleanup()
      }
    },
    renderCall(args, theme) {
      const queries = Array.isArray(args.queries)
        ? (args.queries as string[]).filter(Boolean)
        : []
      const displayQuery =
        typeof args.query === 'string'
          ? args.query
          : queries.length === 1
            ? queries[0]
            : queries.length > 1
              ? `${queries.length} queries: ${queries[0]}`
              : 'search'

      const parts: string[] = []
      if (args.provider) parts.push(`provider=${args.provider}`)
      if (args.limit) parts.push(`limit=${args.limit}`)
      if (args.maxChars) parts.push(`maxChars=${args.maxChars}`)
      if (args.timeout) parts.push(`timeout=${formatDuration(args.timeout)}`)
      if (args.refresh) parts.push('refresh')
      if (queries.length > 1) parts.push(`queries=${queries.length}`)
      return renderToolCallHeader('web_search', displayQuery, 72, parts, theme)
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg('warning', 'Searching...'), 0, 0)

      const details = (result.details || {}) as SearchDetails
      const queryCount = details.queryResults?.length || details.queries?.length || 0
      const isMultiQuery = queryCount > 1
      const sep = theme.fg('dim', ' · ')

      let text: string
      if (details.aborted) {
        text = `${theme.fg('warning', '✗ ')}${theme.fg('warning', 'aborted')}`
      } else if (details.count) {
        const summary = isMultiQuery
          ? `${details.count} results across ${queryCount} queries`
          : `${details.count} results`
        text = `${theme.fg('success', '✓ ')}${theme.fg('success', summary)}`
      } else {
        const summary = isMultiQuery
          ? `no results across ${queryCount} queries`
          : 'no results'
        text = `${theme.fg('dim', '· ')}${theme.fg('dim', summary)}`
      }

      if (details.provider) {
        text += sep + theme.fg('muted', `via ${details.provider}`)
      }
      if (details.cached && details.cacheAgeMs !== undefined) {
        text += sep + theme.fg('dim', `cache ${details.cacheAgeMs}ms old`)
      }
      text += renderBadges(theme, details)

      if (!expanded) {
        return new Text(text, 0, 0)
      }

      if (details.responseId) {
        text += `\n${theme.fg('muted', `responseId: ${details.responseId}`)}`
      }

      if (details.queryResults?.length) {
        const queriesToShow = details.queryResults.slice(0, 4)
        for (const [queryIndex, queryResult] of queriesToShow.entries()) {
          if (isMultiQuery) {
            text += queryIndex === 0 ? '\n' : '\n\n'
            text += theme.fg('accent', theme.bold(truncateText(queryResult.query, 100)))
          }

          const resultsToShow = queryResult.results.slice(0, 5)
          for (const [index, item] of resultsToShow.entries()) {
            text += `\n${theme.fg('accent', `${index + 1}. ${truncateText(item.title, 100)}`)}`
            text += `\n${theme.fg('dim', `   ${truncateText(item.url, 120)}`)}`
            if (item.snippet) {
              text += `\n${theme.fg('muted', `   ${truncateText(item.snippet, 140)}`)}`
            }
          }

          if (queryResult.results.length > resultsToShow.length) {
            text += `\n${theme.fg('muted', `   ... ${queryResult.results.length - resultsToShow.length} more results`)}`
          }
        }

        if (details.queryResults.length > queriesToShow.length) {
          text += `\n${theme.fg('muted', `... ${details.queryResults.length - queriesToShow.length} more queries`)}`
        }
      }

      if (details.attempts?.length) {
        text += `\n\n${theme.fg('muted', 'Attempts:')}`
        for (const attempt of details.attempts) {
          const icon = attempt.ok
            ? theme.fg('success', '✓')
            : theme.fg('warning', '↻')
          const suffix = attempt.ok
            ? ` (${attempt.count ?? 0} results, ${attempt.durationMs}ms)`
            : ` (${attempt.durationMs}ms) ${attempt.error || 'failed'}`
          text += `\n${icon} ${theme.fg('muted', `${attempt.provider}${suffix}`)}`
        }
      }

      if (details.tempFile) {
        text += `\n${theme.fg('muted', `Full output: ${details.tempFile}`)}`
      }

      return new Text(text, 0, 0)
    },
  })
}

export function registerWebSearchTool(pi: ExtensionAPI) {
  pi.registerTool(createWebSearchTool())
}

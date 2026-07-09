import type { SearchProvider, SearchResultItem } from './providers/index.ts'

export type SearchAttempt = {
  provider: SearchProvider['name']
  ok: boolean
  durationMs: number
  count?: number
  error?: string
}

export type SearchQueryDetails = {
  query: string
  count: number
  results: SearchResultItem[]
  provider: SearchProvider['name']
  attempts: SearchAttempt[]
  fallbackUsed: boolean
  durationMs: number
}

export type ProviderFailurePolicy = 'per-query' | 'probe-first-then-parallel'

type SearchBatchState = {
  failedProviders: Map<SearchProvider['name'], SearchAttempt>
}

function getProvidersForQuery(
  providers: SearchProvider[],
  batchState: SearchBatchState | undefined,
) {
  if (!batchState) return providers

  const available = providers.filter(
    (provider) => !batchState.failedProviders.has(provider.name),
  )

  if (available.length) return available

  const lastFailure = [...batchState.failedProviders.values()].at(-1)
  throw new Error(
    lastFailure?.error || 'All configured search providers previously failed for this batch',
  )
}

async function executeSearchQuery(options: {
  query: string
  providers: SearchProvider[]
  limit: number
  controller: AbortController
  onUpdate?: (update: { content: Array<{ type: 'text'; text: string }> }) => void
  queryIndex: number
  totalQueries: number
  batchState?: SearchBatchState
}) {
  const {
    query,
    providers,
    limit,
    controller,
    onUpdate,
    queryIndex,
    totalQueries,
    batchState,
  } = options

  const attempts: SearchAttempt[] = []
  const startedAt = Date.now()
  const progressPrefix =
    totalQueries > 1 ? `[${queryIndex + 1}/${totalQueries}] ` : ''
  const providersToTry = getProvidersForQuery(providers, batchState)

  for (const [index, provider] of providersToTry.entries()) {
    onUpdate?.({
      content: [
        {
          type: 'text',
          text:
            index === 0
              ? `${progressPrefix}Searching ${provider.name} for: ${query}`
              : `${progressPrefix}Primary provider failed, retrying with ${provider.name} for: ${query}`,
        },
      ],
    })

    const attemptStartedAt = Date.now()

    try {
      const results = await provider.search(query, limit, controller.signal)
      attempts.push({
        provider: provider.name,
        ok: true,
        durationMs: Date.now() - attemptStartedAt,
        count: results.length,
      })

      return {
        query,
        count: results.length,
        results,
        provider: provider.name,
        attempts,
        fallbackUsed: attempts.length > 1,
        durationMs: Date.now() - startedAt,
      } satisfies SearchQueryDetails
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error

      const attempt = {
        provider: provider.name,
        ok: false,
        durationMs: Date.now() - attemptStartedAt,
        error: error instanceof Error ? error.message : String(error),
      } satisfies SearchAttempt

      attempts.push(attempt)
      batchState?.failedProviders.set(provider.name, attempt)

      if (index === providersToTry.length - 1) throw error
    }
  }

  throw new Error('Search failed without attempting a provider')
}

async function executeQueriesIndependently(options: {
  queries: string[]
  providers: SearchProvider[]
  limit: number
  controller: AbortController
  onUpdate?: (update: { content: Array<{ type: 'text'; text: string }> }) => void
}) {
  const { queries, providers, limit, controller, onUpdate } = options
  return Promise.all(
    queries.map((query, index) =>
      executeSearchQuery({
        query,
        providers,
        limit,
        controller,
        onUpdate,
        queryIndex: index,
        totalQueries: queries.length,
      }),
    ),
  )
}

async function executeProbeFirstThenParallel(options: {
  queries: string[]
  providers: SearchProvider[]
  limit: number
  controller: AbortController
  onUpdate?: (update: { content: Array<{ type: 'text'; text: string }> }) => void
}) {
  const { queries, providers, limit, controller, onUpdate } = options
  const batchState: SearchBatchState = { failedProviders: new Map() }

  const first = await executeSearchQuery({
    query: queries[0]!,
    providers,
    limit,
    controller,
    onUpdate,
    queryIndex: 0,
    totalQueries: queries.length,
    batchState,
  })

  const remaining = await Promise.all(
    queries.slice(1).map((query, index) =>
      executeSearchQuery({
        query,
        providers,
        limit,
        controller,
        onUpdate,
        queryIndex: index + 1,
        totalQueries: queries.length,
        batchState,
      }),
    ),
  )

  return [first, ...remaining]
}

export async function executeSearchBatch(options: {
  queries: string[]
  providers: SearchProvider[]
  limit: number
  controller: AbortController
  providerFailurePolicy?: ProviderFailurePolicy
  onUpdate?: (update: { content: Array<{ type: 'text'; text: string }> }) => void
}) {
  const {
    queries,
    providers,
    limit,
    controller,
    onUpdate,
    providerFailurePolicy = 'probe-first-then-parallel',
  } = options

  if (queries.length <= 1 || providerFailurePolicy === 'per-query') {
    return executeQueriesIndependently({
      queries,
      providers,
      limit,
      controller,
      onUpdate,
    })
  }

  return executeProbeFirstThenParallel({
    queries,
    providers,
    limit,
    controller,
    onUpdate,
  })
}

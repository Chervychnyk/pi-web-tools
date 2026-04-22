import assert from 'node:assert/strict'
import { parseBraveResults } from '../providers/brave.ts'
import {
  parseDuckDuckGoResults,
  unwrapDuckDuckGoUrl,
} from '../providers/duckduckgo.ts'
import { parseGoogleResults } from '../providers/google.ts'
import { parseKagiResults } from '../providers/kagi.ts'
import {
  MAX_SEARCH_LIMIT,
  clampSearchLimit,
  dedupeResults,
} from '../providers/shared.ts'
import { parseSearXngResults } from '../providers/searxng.ts'
import { resolveSearchProvider, resolveSearchProviders } from '../providers/index.ts'
import { SEARCH_PROVIDER_NAMES } from '../providers/types.ts'
import { getStoredWebResponse } from '../storage.ts'
import { createWebSearchTool, type SearchDetails } from '../web-search.ts'

function testSearchHelpers() {
  assert.deepEqual(SEARCH_PROVIDER_NAMES, [
    'auto',
    'duckduckgo',
    'brave',
    'kagi',
    'google',
    'searxng',
  ])
  assert.equal(MAX_SEARCH_LIMIT, 20)
  assert.equal(clampSearchLimit(0), 1)
  assert.equal(clampSearchLimit(5), 5)
  assert.equal(clampSearchLimit(999), 20)

  assert.equal(
    unwrapDuckDuckGoUrl(
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1',
    ),
    'https://example.com/a?b=1',
  )

  const deduped = dedupeResults(
    [
      { title: ' One ', url: 'https://a.test', snippet: ' Alpha ' },
      { title: 'One', url: 'https://a.test', snippet: 'Alpha' },
      { title: 'Two', url: 'https://b.test', snippet: 'Beta' },
    ],
    10,
  )
  assert.equal(deduped.length, 2)
  assert.equal(deduped[0]?.title, 'One')
  assert.equal(deduped[0]?.snippet, 'Alpha')

  const ddgHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
      <div class="result__snippet"> Useful docs </div>
    </div>
  `
  const ddg = parseDuckDuckGoResults(ddgHtml, 5)
  assert.equal(ddg.length, 1)
  assert.equal(ddg[0]?.url, 'https://example.com/docs')

  const brave = parseBraveResults(
    {
      web: {
        results: [
          {
            title: 'Brave Result',
            url: 'https://brave.test',
            description: 'desc',
          },
        ],
      },
    },
    5,
  )
  assert.equal(brave[0]?.title, 'Brave Result')

  const kagi = parseKagiResults(
    {
      data: [
        { title: 'Kagi Result', url: 'https://kagi.test', snippet: 'desc' },
      ],
    },
    5,
  )
  assert.equal(kagi[0]?.url, 'https://kagi.test')

  const google = parseGoogleResults(
    {
      items: [
        {
          title: 'Google Result',
          link: 'https://google.test',
          snippet: 'desc',
        },
      ],
    },
    5,
  )
  assert.equal(google[0]?.url, 'https://google.test')

  const searxng = parseSearXngResults(
    {
      results: [
        { title: 'SearXNG Result', url: 'https://searx.test', content: 'desc' },
      ],
    },
    5,
  )
  assert.equal(searxng[0]?.snippet, 'desc')
}

function testProviderResolution() {
  assert.equal(resolveSearchProvider('duckduckgo', {}).name, 'duckduckgo')
  assert.deepEqual(
    resolveSearchProviders(undefined, {
      BRAVE_API_KEY: 'x',
      KAGI_API_KEY: 'y',
      SEARXNG_URL: 'https://searx.test',
    }).map((provider) => provider.name),
    ['brave', 'kagi', 'searxng', 'duckduckgo'],
  )
  assert.equal(
    resolveSearchProvider(undefined, { BRAVE_API_KEY: 'x' }).name,
    'brave',
  )
  assert.equal(
    resolveSearchProvider(undefined, { KAGI_API_KEY: 'x' }).name,
    'kagi',
  )
  assert.equal(
    resolveSearchProvider(undefined, {
      GOOGLE_API_KEY: 'x',
      GOOGLE_CX: 'y',
    }).name,
    'google',
  )
  assert.equal(
    resolveSearchProvider(undefined, { SEARXNG_URL: 'https://searx.test' })
      .name,
    'searxng',
  )
  assert.throws(
    () => resolveSearchProvider('nope' as never, {}),
    /Unknown search provider/,
  )
}

async function testWebSearchExecutePaths() {
  let primaryCalls = 0
  let fallbackCalls = 0
  const fallbackTool = createWebSearchTool({
    resolveProviders: () => [
      {
        name: 'duckduckgo',
        search: async () => {
          primaryCalls += 1
          throw new Error('primary failed')
        },
      },
      {
        name: 'brave',
        search: async (query) => {
          fallbackCalls += 1
          return [
            {
              title: `${query} docs`,
              url: 'https://example.com/docs',
              snippet: 'Example docs',
            },
          ]
        },
      },
    ],
  })

  const fallbackResult = await fallbackTool.execute(
    'search-tool-1',
    { query: 'alpha docs', limit: 1, refresh: true },
    undefined,
    undefined,
  )
  const fallbackDetails = fallbackResult.details as SearchDetails
  const fallbackText = fallbackResult.content[0] as { type: 'text'; text: string }

  assert.equal(primaryCalls, 1)
  assert.equal(fallbackCalls, 1)
  assert.equal(fallbackDetails.provider, 'brave')
  assert.equal(fallbackDetails.fallbackUsed, true)
  assert.ok(fallbackDetails.responseId)
  assert.match(fallbackText.text, /responseId:/)

  let cacheCalls = 0
  const cacheQuery = `cached-query-${Date.now().toString(36)}`
  const cacheTool = createWebSearchTool({
    resolveProviders: () => [
      {
        name: 'duckduckgo',
        search: async () => {
          cacheCalls += 1
          return [
            {
              title: 'Cached Result',
              url: 'https://cached.test',
              snippet: 'Cached snippet',
            },
          ]
        },
      },
    ],
  })

  await cacheTool.execute(
    'search-tool-2',
    { query: cacheQuery, limit: 1 },
    undefined,
    undefined,
  )
  const cachedResult = await cacheTool.execute(
    'search-tool-3',
    { query: cacheQuery, limit: 1 },
    undefined,
    undefined,
  )
  const cachedDetails = cachedResult.details as SearchDetails

  assert.equal(cacheCalls, 1)
  assert.equal(cachedDetails.cached, true)
  assert.equal(cachedDetails.count, 1)
}

async function testSearchBatchProviderMemoization() {
  let primaryCalls = 0
  let fallbackCalls = 0

  const tool = createWebSearchTool({
    resolveProviders: () => [
      {
        name: 'duckduckgo',
        search: async () => {
          primaryCalls += 1
          throw new Error('provider unavailable')
        },
      },
      {
        name: 'brave',
        search: async (query) => {
          fallbackCalls += 1
          return [
            {
              title: `${query} result`,
              url: `https://example.com/${encodeURIComponent(query)}`,
              snippet: 'Fallback result',
            },
          ]
        },
      },
    ],
  })

  const result = await tool.execute(
    'search-tool-batch',
    {
      queries: ['alpha', 'beta', 'gamma'],
      limit: 1,
      refresh: true,
    },
    undefined,
    undefined,
  )

  const details = result.details as SearchDetails
  assert.equal(primaryCalls, 1)
  assert.equal(fallbackCalls, 3)
  assert.equal(details.count, 3)
}

async function testSearchPreviewCompaction() {
  const tool = createWebSearchTool({
    resolveProviders: () => [
      {
        name: 'duckduckgo',
        search: async (query) =>
          Array.from({ length: 5 }, (_, index) => ({
            title: `${query} result ${index + 1}`,
            url: `https://example.com/${query}/${index + 1}`,
            snippet: `Snippet ${index + 1}`,
          })),
      },
    ],
  })

  const result = await tool.execute(
    'search-tool-preview',
    {
      queries: ['alpha', 'beta'],
      limit: 5,
      refresh: true,
    },
    undefined,
    undefined,
  )

  const details = result.details as SearchDetails
  const content = result.content[0] as { type: 'text'; text: string }
  const stored = details.responseId
    ? getStoredWebResponse(details.responseId)
    : undefined

  assert.match(content.text, /alpha result 1/)
  assert.doesNotMatch(content.text, /alpha result 5/)
  assert.match(content.text, /2 more results/)
  assert.equal(stored?.kind, 'search')
  assert.equal(stored?.queryResults[0]?.results.length, 5)
  assert.equal('messageText' in (stored?.queryResults[0] || {}), false)
}

export async function runSearchTests() {
  testSearchHelpers()
  testProviderResolution()
  await testWebSearchExecutePaths()
  await testSearchBatchProviderMemoization()
  await testSearchPreviewCompaction()
}

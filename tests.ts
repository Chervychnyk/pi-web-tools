import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { parseBraveResults } from './providers/brave.ts'
import {
  parseDuckDuckGoResults,
  unwrapDuckDuckGoUrl,
} from './providers/duckduckgo.ts'
import { parseGoogleResults } from './providers/google.ts'
import { parseKagiResults } from './providers/kagi.ts'
import {
  MAX_SEARCH_LIMIT,
  clampSearchLimit,
  dedupeResults,
} from './providers/shared.ts'
import { parseSearXngResults } from './providers/searxng.ts'
import { resolveSearchProvider, resolveSearchProviders } from './providers/index.ts'
import { SEARCH_PROVIDER_NAMES } from './providers/types.ts'
import {
  isGitHubCacheStale,
  parseGitHubUrl,
  pruneGitHubCacheDir,
  resolveGitHubRefPath,
  resolveWithinRepo,
} from './github.ts'
import {
  buildJinaReaderUrl,
  createWebFetchTool,
  decodeBodyAsText,
  decodeContentEncoding,
  extractPdfText,
  fetchWithOptionalCloudflareRetry,
  fetchWithRedirects,
  getResponseByteLimit,
  isBlockedHostname,
  isPdfMimeType,
  isPdfUrl,
  isPrivateIpAddress,
  looksLikeBlockedOrJunkContent,
  parseCharsetFromContentType,
  parseContentLength,
  shouldApplyHtmlGuard,
  shouldUseJinaFallbackForStatus,
  type GuardedFetchResponse,
  type GuardedRequester,
} from './web-fetch.ts'
import {
  appendStoredResponseNote,
  buildCacheKey,
  getCachedValue,
  setCachedValue,
} from './shared.ts'
import { createGetWebContentTool, type GetWebContentDetails } from './get-web-content.ts'
import {
  getStoredWebResponse,
  sliceStoredText,
  storeWebResponse,
  tryStoreWebResponse,
} from './storage.ts'
import { createWebSearchTool, type SearchDetails } from './web-search.ts'

const previousStorageDir = process.env.PI_WEB_TOOLS_STORAGE_DIR
const previousGitHubDir = process.env.PI_WEB_TOOLS_GITHUB_DIR
const suiteCacheRoot = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-suite-'))
process.env.PI_WEB_TOOLS_STORAGE_DIR = path.join(suiteCacheRoot, 'storage')
process.env.PI_WEB_TOOLS_GITHUB_DIR = path.join(suiteCacheRoot, 'github')

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

function testCacheHelpers() {
  const keyA = buildCacheKey({ b: 2, a: 1, list: ['x', { z: 1, y: 2 }] })
  const keyB = buildCacheKey({ a: 1, list: ['x', { y: 2, z: 1 }], b: 2 })
  assert.equal(keyA, keyB)

  setCachedValue('cache:test', { value: 1 }, 1000, 100)
  assert.deepEqual(getCachedValue<{ value: number }>('cache:test', 150), {
    value: { value: 1 },
    ageMs: 50,
  })
  assert.equal(getCachedValue('cache:test', 1200), undefined)

  const noted = appendStoredResponseNote('hello', 'wt_test123')
  assert.match(noted, /responseId: wt_test123/)
  assert.match(noted, /get_web_content/)
}

function testGitHubHelpers() {
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo'), {
    owner: 'owner',
    repo: 'repo',
    refIsFullSha: false,
    type: 'root',
  })
  assert.deepEqual(parseGitHubUrl('https://m.github.com/owner/repo'), {
    owner: 'owner',
    repo: 'repo',
    refIsFullSha: false,
    type: 'root',
  })
  assert.deepEqual(parseGitHubUrl('https://github.com./owner/repo'), {
    owner: 'owner',
    repo: 'repo',
    refIsFullSha: false,
    type: 'root',
  })
  assert.deepEqual(
    parseGitHubUrl('https://github.com/owner/repo/blob/main/src/index.ts'),
    {
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      refIsFullSha: false,
      path: 'src/index.ts',
      type: 'blob',
      refPathSegments: ['main', 'src', 'index.ts'],
    },
  )
  assert.equal(
    parseGitHubUrl('https://github.com/owner/repo/issues/123'),
    null,
  )
  assert.deepEqual(
    resolveGitHubRefPath(['feature', 'foo', 'src', 'index.ts'], [
      'main',
      'feature/foo',
    ]),
    {
      ref: 'feature/foo',
      path: 'src/index.ts',
    },
  )

  const root = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-gh-'))
  try {
    mkdirSync(path.join(root, 'src'))
    writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n')
    symlinkSync('/tmp', path.join(root, 'src', 'tmp-link'))

    assert.equal(
      resolveWithinRepo(root, 'src/index.ts'),
      path.join(root, 'src', 'index.ts'),
    )
    assert.equal(resolveWithinRepo(root, '../outside.txt'), null)
    assert.equal(resolveWithinRepo(root, 'src/tmp-link'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function testGitHubCacheHelpers() {
  assert.equal(isGitHubCacheStale(0, 10_000, 5_000), true)
  assert.equal(isGitHubCacheStale(6_000, 10_000, 5_000), false)

  const overflowRoot = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-gh-overflow-'))
  try {
    const newest = path.join(overflowRoot, 'owner-a', 'repo-newest')
    const recent = path.join(overflowRoot, 'owner-a', 'repo-recent')
    const overflow = path.join(overflowRoot, 'owner-b', 'repo-overflow')

    for (const repoPath of [newest, recent, overflow]) {
      mkdirSync(path.join(repoPath, '.git'), { recursive: true })
      const relativeRepoPath = path.relative(overflowRoot, repoPath)
      const metadataPath = path.join(
        overflowRoot,
        '.meta',
        relativeRepoPath,
        '.pi-web-tools-cache-touch',
      )
      mkdirSync(path.dirname(metadataPath), { recursive: true })
      writeFileSync(metadataPath, 'touch\n')
    }

    utimesSync(
      path.join(overflowRoot, '.meta', 'owner-a', 'repo-newest', '.pi-web-tools-cache-touch'),
      new Date(4_000),
      new Date(4_000),
    )
    utimesSync(
      path.join(overflowRoot, '.meta', 'owner-a', 'repo-recent', '.pi-web-tools-cache-touch'),
      new Date(3_000),
      new Date(3_000),
    )
    utimesSync(
      path.join(overflowRoot, '.meta', 'owner-b', 'repo-overflow', '.pi-web-tools-cache-touch'),
      new Date(2_000),
      new Date(2_000),
    )

    pruneGitHubCacheDir(overflowRoot, {
      maxRepos: 2,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      now: 5_000,
    })

    assert.equal(existsSync(newest), true)
    assert.equal(existsSync(recent), true)
    assert.equal(existsSync(overflow), false)
  } finally {
    rmSync(overflowRoot, { recursive: true, force: true })
  }

  const expiryRoot = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-gh-expiry-'))
  try {
    const staleRepo = path.join(expiryRoot, 'owner-c', 'repo-stale')
    mkdirSync(path.join(staleRepo, '.git'), { recursive: true })
    const staleMetadataPath = path.join(
      expiryRoot,
      '.meta',
      'owner-c',
      'repo-stale',
      '.pi-web-tools-cache-touch',
    )
    mkdirSync(path.dirname(staleMetadataPath), { recursive: true })
    writeFileSync(staleMetadataPath, 'touch\n')
    utimesSync(
      path.join(expiryRoot, '.meta', 'owner-c', 'repo-stale', '.pi-web-tools-cache-touch'),
      new Date(1_000),
      new Date(1_000),
    )

    pruneGitHubCacheDir(expiryRoot, {
      maxRepos: 10,
      maxAgeMs: 1_000,
      now: 5_000,
    })

    assert.equal(existsSync(staleRepo), false)
  } finally {
    rmSync(expiryRoot, { recursive: true, force: true })
  }
}

function testStoredResponseHelpers() {
  const previousStorageDir = process.env.PI_WEB_TOOLS_STORAGE_DIR
  const previousStorageMaxAge = process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS
  const storageDir = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-test-'))
  process.env.PI_WEB_TOOLS_STORAGE_DIR = storageDir

  try {
    const storedSearch = storeWebResponse({
      kind: 'search',
      requestedProvider: 'auto',
      queries: ['alpha', 'beta'],
      queryResults: [
        {
          query: 'alpha',
          provider: 'duckduckgo',
          count: 1,
          results: [
            { title: 'Alpha', url: 'https://alpha.test', snippet: 'One' },
          ],
          attempts: [
            { provider: 'duckduckgo', ok: true, durationMs: 12, count: 1 },
          ],
          fallbackUsed: false,
          durationMs: 12,
          messageText: '## Query: alpha\n\n1. Alpha\n   https://alpha.test',
        },
        {
          query: 'beta',
          provider: 'duckduckgo',
          count: 0,
          results: [],
          attempts: [
            { provider: 'duckduckgo', ok: true, durationMs: 8, count: 0 },
          ],
          fallbackUsed: false,
          durationMs: 8,
          messageText: '## Query: beta\n\nNo results found for: beta',
        },
      ],
      messageText:
        '## Query: alpha\n\n1. Alpha\n   https://alpha.test\n\n---\n\n## Query: beta\n\nNo results found for: beta',
    })
    assert.equal(storedSearch.kind, 'search')
    assert.ok(storedSearch.responseId.startsWith('wt_'))
    assert.equal(
      getStoredWebResponse(storedSearch.responseId)?.kind,
      'search',
    )

    const storedFetch = storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/docs',
      finalUrl: 'https://example.com/docs',
      format: 'markdown',
      title: 'Example Docs',
      selectedSelector: 'main',
      contentType: 'text/html',
      messageText: '# Example Docs\n\nLine 1\nLine 2\nLine 3',
    })
    assert.equal(
      getStoredWebResponse(storedFetch.responseId)?.kind,
      'fetch',
    )

    const slice = sliceStoredText('a\nb\nc', 2, 1)
    assert.deepEqual(slice, {
      text: 'b',
      offset: 2,
      limit: 1,
      returnedLines: 1,
      totalLines: 3,
      hasMore: true,
      nextOffset: 3,
    })

    const finalSlice = sliceStoredText('a\nb\nc', 3, 1)
    assert.equal(finalSlice.hasMore, false)
    assert.equal(finalSlice.nextOffset, undefined)

    assert.throws(() => sliceStoredText('a\nb', 3, 1), /Offset 3 is beyond/)

    process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS = '1'

    const stale = storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/stale',
      finalUrl: 'https://example.com/stale',
      format: 'text',
      messageText: 'stale content',
    })
    const stalePath = path.join(
      storageDir,
      'responses',
      `${stale.responseId}.json`,
    )
    utimesSync(stalePath, new Date(0), new Date(0))

    const fresh = storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/fresh',
      finalUrl: 'https://example.com/fresh',
      format: 'text',
      messageText: 'fresh content',
    })

    assert.equal(getStoredWebResponse(stale.responseId), undefined)
    assert.equal(getStoredWebResponse(fresh.responseId)?.kind, 'fetch')

    process.env.PI_WEB_TOOLS_STORAGE_DIR = '/dev/null'
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      assert.equal(
        tryStoreWebResponse({
          kind: 'fetch',
          requestUrl: 'https://example.com/fail',
          finalUrl: 'https://example.com/fail',
          format: 'text',
          messageText: 'should not throw',
        }),
        undefined,
      )
    } finally {
      console.warn = originalWarn
    }
  } finally {
    if (previousStorageDir === undefined) {
      delete process.env.PI_WEB_TOOLS_STORAGE_DIR
    } else {
      process.env.PI_WEB_TOOLS_STORAGE_DIR = previousStorageDir
    }

    if (previousStorageMaxAge === undefined) {
      delete process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS
    } else {
      process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS = previousStorageMaxAge
    }

    rmSync(storageDir, { recursive: true, force: true })
  }
}

function createHeaders(entries: Record<string, string>) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(entries)) headers.set(key, value)
  return headers
}

function createResponse(
  url: string,
  status: number,
  headers: Record<string, string> = {},
): GuardedFetchResponse {
  return {
    url,
    status,
    statusText: status === 200 ? 'OK' : status === 302 ? 'Found' : status === 403 ? 'Forbidden' : '',
    headers: createHeaders(headers),
    ok: status >= 200 && status < 300,
    bodyBuffer: Buffer.from('test'),
  }
}

async function testMockedFetchFlows() {
  const visited: string[] = []
  const redirectingRequester: GuardedRequester = async (url, _signal, _userAgent) => {
    visited.push(url.toString())
    if (url.pathname === '/start') {
      return createResponse(url.toString(), 302, { location: '/final' })
    }
    return createResponse(url.toString(), 200)
  }

  const redirected = await fetchWithRedirects(
    new URL('https://example.com/start'),
    new AbortController().signal,
    'agent',
    redirectingRequester,
  )
  assert.equal(redirected.url, 'https://example.com/final')
  assert.deepEqual(visited, [
    'https://example.com/start',
    'https://example.com/final',
  ])

  const blockedRedirectRequester: GuardedRequester = async () =>
    createResponse('https://example.com/start', 302, {
      location: 'http://localhost/admin',
    })
  await assert.rejects(
    () =>
      fetchWithRedirects(
        new URL('https://example.com/start'),
        new AbortController().signal,
        'agent',
        blockedRedirectRequester,
      ),
    /Blocked hostname: localhost/,
  )

  const loopingRequester: GuardedRequester = async (url) =>
    createResponse(url.toString(), 302, { location: '/loop' })
  await assert.rejects(
    () =>
      fetchWithRedirects(
        new URL('https://example.com/loop'),
        new AbortController().signal,
        'agent',
        loopingRequester,
      ),
    /Too many redirects/,
  )

  const userAgents: string[] = []
  const updates: string[] = []
  let attempts = 0
  const cloudflareRequester: GuardedRequester = async (url, _signal, userAgent) => {
    attempts += 1
    userAgents.push(userAgent)
    if (attempts === 1) {
      return createResponse(url.toString(), 403, {
        server: 'cloudflare',
        'cf-mitigated': 'challenge',
      })
    }
    return createResponse(url.toString(), 200)
  }

  const retried = await fetchWithOptionalCloudflareRetry(
    new URL('https://example.com/docs'),
    new AbortController().signal,
    (update) => {
      updates.push(update.content.map((item) => item.text).join('\n'))
    },
    cloudflareRequester,
  )
  assert.equal(retried.cloudflareBypassed, true)
  assert.equal(retried.response.status, 200)
  assert.deepEqual(userAgents, ['pi-web-fetch/1.1', 'web_fetch/1.1'])
  assert.ok(
    updates.some((text) => text.includes('Cloudflare challenge detected')),
  )
}

async function testAbortHandling() {
  const controller = new AbortController()
  const abortingRequester: GuardedRequester = async (_url, signal) => {
    await Promise.resolve()
    controller.abort()
    if (signal.aborted) {
      const error = new Error('request aborted')
      error.name = 'AbortError'
      throw error
    }
    return createResponse('https://example.com/never', 200)
  }

  await assert.rejects(
    () =>
      fetchWithRedirects(
        new URL('https://example.com/data'),
        controller.signal,
        'agent',
        abortingRequester,
      ),
    /request aborted/,
  )
}

function shouldAttemptStatusFallback(
  requestedFormat: string | undefined,
  selector: string | undefined,
  status: number,
) {
  return (
    !selector &&
    (requestedFormat === undefined ||
      requestedFormat === 'markdown' ||
      requestedFormat === 'text') &&
    shouldUseJinaFallbackForStatus(status)
  )
}

async function testPdfHelpers() {
  assert.equal(isPdfMimeType('application/pdf'), true)
  assert.equal(isPdfMimeType('application/x-pdf'), true)
  assert.equal(isPdfMimeType('text/html'), false)
  assert.equal(isPdfUrl('https://example.com/spec.pdf'), true)
  assert.equal(isPdfUrl('https://example.com/spec.PDF?download=1'), true)
  assert.equal(isPdfUrl('https://example.com/docs'), false)

  const minimalPdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT\n/F1 24 Tf\n72 100 Td\n(Hello PDF) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000241 00000 n \n0000000335 00000 n \ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n406\n%%EOF\n`)

  // Prefer native pdftotext path when available.
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
    const extracted = await extractPdfText(minimalPdf)
    assert.match(extracted, /Hello PDF/)
  } catch {
    console.log('Skipping pdftotext extraction path: binary not installed')
  }

  // Verify JS fallback path by temporarily removing PATH.
  const previousPath = process.env.PATH
  process.env.PATH = ''
  try {
    const extractedViaJsFallback = await extractPdfText(minimalPdf)
    assert.match(extractedViaJsFallback, /Hello PDF/)
  } finally {
    process.env.PATH = previousPath
  }
}

async function testWebFetchExecutePaths() {
  const tool = createWebFetchTool({
    githubFetcher: async () => null,
    networkFetcher: async () => ({
      response: createResponse('https://example.com/protected', 403, {
        'content-type': 'text/html; charset=utf-8',
      }),
      cloudflareBypassed: false,
    }),
    jinaFetcher: async () => {
      throw new Error('jina should not be used')
    },
    pdfTextExtractor: async () => 'unused',
  })

  await assert.rejects(
    () =>
      tool.execute(
        'tool-1',
        { url: 'https://example.com/protected', format: 'html' },
        undefined,
        undefined,
      ),
    /Fetch failed: 403/,
  )

  await assert.rejects(
    () =>
      tool.execute(
        'tool-2',
        {
          url: 'https://example.com/protected',
          format: 'markdown',
          selector: 'main',
        },
        undefined,
        undefined,
      ),
    /Fetch failed: 403/,
  )

  let networkCalls = 0
  let jinaCalls = 0
  const githubTool = createWebFetchTool({
    githubFetcher: async () => ({
      text: '# repo\n\ncontent',
      title: 'owner/repo',
      finalUrl: 'https://github.com/owner/repo',
      contentType: 'text/x-github-repository',
      githubType: 'root',
      githubLocalPath: '/tmp/repo',
    }),
    networkFetcher: async () => {
      networkCalls += 1
      return {
        response: createResponse('https://example.com/never', 200),
        cloudflareBypassed: false,
      }
    },
    jinaFetcher: async () => {
      jinaCalls += 1
      return {
        response: createResponse('https://r.jina.ai/http://example.com', 200),
        content: 'unexpected',
      }
    },
    pdfTextExtractor: async () => 'unused',
  })

  const githubResult = await githubTool.execute(
    'tool-3',
    { url: 'https://github.com/owner/repo', format: 'markdown' },
    undefined,
    undefined,
  )
  assert.equal(networkCalls, 0)
  assert.equal(jinaCalls, 0)
  assert.equal((githubResult.details as any).githubType, 'root')

  let redirectedGithubCalls = 0
  const redirectedGithubTool = createWebFetchTool({
    githubFetcher: async (requestUrl) => {
      if (!requestUrl.includes('github.com/owner/repo')) return null
      redirectedGithubCalls += 1
      return {
        text: '# redirected repo\n\ncontent',
        title: 'owner/repo',
        finalUrl: 'https://github.com/owner/repo',
        contentType: 'text/x-github-repository-api',
        githubType: 'root',
        githubSource: 'api',
      }
    },
    networkFetcher: async () => ({
      response: {
        ...createResponse('https://github.com/owner/repo', 200, {
          'content-type': 'text/html; charset=utf-8',
        }),
        bodyBuffer: Buffer.from('<html><body>github page</body></html>', 'utf8'),
      },
      cloudflareBypassed: false,
    }),
    jinaFetcher: async () => ({
      response: createResponse('https://r.jina.ai/http://example.com', 200),
      content: 'unexpected',
    }),
    pdfTextExtractor: async () => 'unused',
  })

  const redirectedGithubResult = await redirectedGithubTool.execute(
    'tool-3b',
    { url: 'https://example.com/redirect-to-github', format: 'markdown' },
    undefined,
    undefined,
  )
  assert.equal(redirectedGithubCalls, 1)
  assert.equal((redirectedGithubResult.details as any).githubType, 'root')
  assert.equal((redirectedGithubResult.details as any).githubSource, 'api')

  let pdfExtractorCalls = 0
  const pdfTool = createWebFetchTool({
    githubFetcher: async () => null,
    networkFetcher: async () => ({
      response: {
        ...createResponse('https://example.com/spec.pdf', 200, {
          'content-type': 'application/pdf',
        }),
        bodyBuffer: Buffer.from('%PDF-1.4 fake'),
      },
      cloudflareBypassed: false,
    }),
    jinaFetcher: async () => ({
      response: createResponse('https://r.jina.ai/http://example.com', 200),
      content: 'unexpected',
    }),
    pdfTextExtractor: async () => {
      pdfExtractorCalls += 1
      return 'PDF body text'
    },
  })

  const pdfResult = await pdfTool.execute(
    'tool-4',
    { url: 'https://example.com/spec.pdf', format: 'text' },
    undefined,
    undefined,
  )
  assert.equal(pdfExtractorCalls, 1)
  assert.equal((pdfResult.details as any).pdfExtracted, true)
  assert.match((pdfResult.content[0] as any).text, /PDF body text/)

  const compressedTool = createWebFetchTool({
    githubFetcher: async () => null,
    networkFetcher: async () => ({
      response: {
        ...createResponse('https://example.com/latin1', 200, {
          'content-type': 'text/plain; charset=iso-8859-1',
          'content-encoding': 'gzip',
        }),
        bodyBuffer: gzipSync(Buffer.from('café', 'latin1')),
      },
      cloudflareBypassed: false,
    }),
    jinaFetcher: async () => ({
      response: createResponse('https://r.jina.ai/http://example.com', 200),
      content: 'unexpected',
    }),
    pdfTextExtractor: async () => 'unused',
  })

  const compressedResult = await compressedTool.execute(
    'tool-5',
    { url: 'https://example.com/latin1', format: 'text' },
    undefined,
    undefined,
  )
  assert.match((compressedResult.content[0] as any).text, /café/)

  const selectorTool = createWebFetchTool({
    githubFetcher: async () => null,
    networkFetcher: async () => ({
      response: {
        ...createResponse('https://example.com/text', 200, {
          'content-type': 'text/plain; charset=utf-8',
        }),
        bodyBuffer: Buffer.from('plain text body', 'utf8'),
      },
      cloudflareBypassed: false,
    }),
    jinaFetcher: async () => ({
      response: createResponse('https://r.jina.ai/http://example.com', 200),
      content: 'unexpected',
    }),
    pdfTextExtractor: async () => 'unused',
  })

  await assert.rejects(
    () =>
      selectorTool.execute(
        'tool-6',
        {
          url: 'https://example.com/text',
          format: 'text',
          selector: 'main',
        },
        undefined,
        undefined,
      ),
    /Selector is only supported for HTML responses/,
  )

  let statusFallbackUrl = ''
  const statusFallbackTool = createWebFetchTool({
    githubFetcher: async () => null,
    networkFetcher: async () => ({
      response: createResponse('https://example.com/final-login', 403, {
        'content-type': 'text/html; charset=utf-8',
      }),
      cloudflareBypassed: false,
    }),
    jinaFetcher: async (sourceUrl) => {
      statusFallbackUrl = sourceUrl.toString()
      return {
        response: createResponse('https://r.jina.ai/http://example.com', 200),
        content: 'status fallback content',
      }
    },
    pdfTextExtractor: async () => 'unused',
  })

  await statusFallbackTool.execute(
    'tool-7',
    { url: 'https://example.com/start', format: 'markdown' },
    undefined,
    undefined,
  )
  assert.equal(statusFallbackUrl, 'https://example.com/final-login')

  let junkFallbackUrl = ''
  const junkFallbackTool = createWebFetchTool({
    githubFetcher: async () => null,
    networkFetcher: async () => ({
      response: {
        ...createResponse('https://example.com/final-page', 200, {
          'content-type': 'text/html; charset=utf-8',
        }),
        bodyBuffer: Buffer.from(
          '<html><body>Please enable JavaScript to continue.</body></html>',
          'utf8',
        ),
      },
      cloudflareBypassed: false,
    }),
    jinaFetcher: async (sourceUrl) => {
      junkFallbackUrl = sourceUrl.toString()
      return {
        response: createResponse('https://r.jina.ai/http://example.com', 200),
        content: 'junk fallback content',
      }
    },
    pdfTextExtractor: async () => 'unused',
  })

  await junkFallbackTool.execute(
    'tool-8',
    { url: 'https://example.com/original', format: 'text' },
    undefined,
    undefined,
  )
  assert.equal(junkFallbackUrl, 'https://example.com/final-page')
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

async function testGetWebContentExecutePaths() {
  const stored = storeWebResponse({
    kind: 'search',
    requestedProvider: 'auto',
    queries: ['alpha'],
    queryResults: [
      {
        query: 'alpha',
        provider: 'duckduckgo',
        count: 1,
        results: [
          {
            title: 'Alpha Result',
            url: 'https://alpha.test',
            snippet: 'Example snippet',
          },
        ],
        attempts: [{ provider: 'duckduckgo', ok: true, durationMs: 10, count: 1 }],
        fallbackUsed: false,
        durationMs: 10,
        messageText: 'line 1\nline 2\nline 3',
      },
    ],
    messageText: 'line 1\nline 2\nline 3',
  })

  const tool = createGetWebContentTool()
  const result = await tool.execute(
    'content-tool-1',
    { responseId: stored.responseId, query: 'alpha', offset: 1, limit: 1 },
    undefined,
    undefined,
  )
  const details = result.details as GetWebContentDetails
  const content = result.content[0] as { type: 'text'; text: string }

  assert.equal(details.selectedQuery, 'alpha')
  assert.equal(details.returnedLines, 1)
  assert.equal(details.hasMore, true)
  assert.equal(details.nextOffset, 2)
  assert.match(content.text, /Continue with: get_web_content/)
}

function testJinaHelpers() {
  assert.equal(
    buildJinaReaderUrl('https://example.com/docs?q=1').toString(),
    'https://r.jina.ai/http://example.com/docs?q=1',
  )
  assert.equal(shouldUseJinaFallbackForStatus(403), true)
  assert.equal(shouldUseJinaFallbackForStatus(429), true)
  assert.equal(shouldUseJinaFallbackForStatus(200), false)
  assert.equal(shouldAttemptStatusFallback(undefined, undefined, 403), true)
  assert.equal(shouldAttemptStatusFallback('markdown', undefined, 429), true)
  assert.equal(shouldAttemptStatusFallback('text', undefined, 503), true)
  assert.equal(shouldAttemptStatusFallback('html', undefined, 403), false)
  assert.equal(shouldAttemptStatusFallback('json', undefined, 403), false)
  assert.equal(shouldAttemptStatusFallback('markdown', 'main', 403), false)
  assert.equal(looksLikeBlockedOrJunkContent('Please enable JavaScript to continue'), true)
  assert.equal(looksLikeBlockedOrJunkContent('Short text'), true)
  assert.equal(
    looksLikeBlockedOrJunkContent(
      'This is a long enough article body with meaningful content that should not be treated as blocked or junk because it contains explanatory sentences, structure, and enough text to pass the heuristic safely.',
    ),
    false,
  )
}

function testResponseDecodingHelpers() {
  const plain = Buffer.from('Hello café', 'utf8')

  assert.equal(
    decodeContentEncoding(gzipSync(plain), 'gzip').toString('utf8'),
    'Hello café',
  )
  assert.equal(
    decodeContentEncoding(deflateSync(plain), 'deflate').toString('utf8'),
    'Hello café',
  )
  assert.equal(
    decodeContentEncoding(brotliCompressSync(plain), 'br').toString('utf8'),
    'Hello café',
  )

  const layered = brotliCompressSync(gzipSync(plain))
  assert.equal(
    decodeContentEncoding(layered, 'gzip, br').toString('utf8'),
    'Hello café',
  )

  assert.throws(
    () => decodeContentEncoding(plain, 'compress'),
    /Unsupported content-encoding/,
  )

  assert.equal(
    parseCharsetFromContentType('text/plain; charset=ISO-8859-1'),
    'iso-8859-1',
  )

  const latin1 = Buffer.from('café', 'latin1')
  assert.equal(
    decodeBodyAsText(latin1, 'text/plain; charset=iso-8859-1'),
    'café',
  )
}

function testFetchGuardHelpers() {
  assert.equal(parseContentLength(null), undefined)
  assert.equal(parseContentLength('1234'), 1234)
  assert.equal(parseContentLength('abc'), undefined)

  assert.equal(getResponseByteLimit('text/html'), 5 * 1024 * 1024)
  assert.equal(getResponseByteLimit('application/json'), 5 * 1024 * 1024)
  assert.equal(getResponseByteLimit('application/pdf'), 25 * 1024 * 1024)
  assert.equal(getResponseByteLimit('image/png'), 20 * 1024 * 1024)

  assert.equal(isBlockedHostname('localhost'), true)
  assert.equal(isBlockedHostname('api.localhost'), true)
  assert.equal(isBlockedHostname('example.com'), false)

  assert.equal(isPrivateIpAddress('127.0.0.1'), true)
  assert.equal(isPrivateIpAddress('10.0.0.8'), true)
  assert.equal(isPrivateIpAddress('172.16.5.4'), true)
  assert.equal(isPrivateIpAddress('192.168.1.10'), true)
  assert.equal(isPrivateIpAddress('169.254.169.254'), true)
  assert.equal(isPrivateIpAddress('8.8.8.8'), false)
  assert.equal(isPrivateIpAddress('::1'), true)
  assert.equal(isPrivateIpAddress('fc00::1'), true)
  assert.equal(isPrivateIpAddress('fe80::1'), true)
  assert.equal(isPrivateIpAddress('2606:4700:4700::1111'), false)
  assert.equal(isPrivateIpAddress('::ffff:127.0.0.1'), true)

  assert.equal(
    shouldApplyHtmlGuard('text/html', 'markdown', 6 * 1024 * 1024),
    true,
  )
  assert.equal(
    shouldApplyHtmlGuard('text/html', 'json', 6 * 1024 * 1024),
    false,
  )
  assert.equal(
    shouldApplyHtmlGuard('application/json', 'markdown', 6 * 1024 * 1024),
    false,
  )
  assert.equal(shouldApplyHtmlGuard('text/html', 'markdown', 1024), false)
}

try {
  await testMockedFetchFlows()
  await testAbortHandling()
  await testPdfHelpers()
  await testWebFetchExecutePaths()
  await testWebSearchExecutePaths()
  await testGetWebContentExecutePaths()
  testSearchHelpers()
  testProviderResolution()
  testCacheHelpers()
  testGitHubHelpers()
  testGitHubCacheHelpers()
  testStoredResponseHelpers()
  testJinaHelpers()
  testResponseDecodingHelpers()
  testFetchGuardHelpers()
  console.log('tests ok')
} finally {
  if (previousStorageDir === undefined) {
    delete process.env.PI_WEB_TOOLS_STORAGE_DIR
  } else {
    process.env.PI_WEB_TOOLS_STORAGE_DIR = previousStorageDir
  }

  if (previousGitHubDir === undefined) {
    delete process.env.PI_WEB_TOOLS_GITHUB_DIR
  } else {
    process.env.PI_WEB_TOOLS_GITHUB_DIR = previousGitHubDir
  }

  rmSync(suiteCacheRoot, { recursive: true, force: true })
}

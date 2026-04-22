import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
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
} from '../web-fetch.ts'

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

  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
    const extracted = await extractPdfText(minimalPdf)
    assert.match(extracted, /Hello PDF/)
  } catch {
    console.log('Skipping pdftotext extraction path: binary not installed')
  }

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

async function testImagesBypassInMemoryCache() {
  let networkCalls = 0
  const imageTool = createWebFetchTool({
    githubFetcher: async () => null,
    networkFetcher: async () => {
      networkCalls += 1
      return {
        response: {
          ...createResponse('https://example.com/image.png', 200, {
            'content-type': 'image/png',
          }),
          bodyBuffer: Buffer.from([1, 2, 3, 4]),
        },
        cloudflareBypassed: false,
      }
    },
    jinaFetcher: async () => ({
      response: createResponse('https://r.jina.ai/http://example.com', 200),
      content: 'unexpected',
    }),
    pdfTextExtractor: async () => 'unused',
  })

  await imageTool.execute(
    'tool-image-1',
    { url: 'https://example.com/image.png' },
    undefined,
    undefined,
  )
  await imageTool.execute(
    'tool-image-2',
    { url: 'https://example.com/image.png' },
    undefined,
    undefined,
  )

  assert.equal(networkCalls, 2)
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

export async function runFetchTests() {
  await testMockedFetchFlows()
  await testAbortHandling()
  await testPdfHelpers()
  await testWebFetchExecutePaths()
  await testImagesBypassInMemoryCache()
  testJinaHelpers()
  testResponseDecodingHelpers()
  testFetchGuardHelpers()
}

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, it } from 'node:test'
import { clearToolCache } from '../utils/cache.ts'
import { buildFetchTool, createResponse, getTextContent } from './helpers.ts'

describe('createWebFetchTool — execute()', () => {
  beforeEach(() => clearToolCache())

  it('throws a structured WebFetchError on 4xx + format=html (no Jina)', async () => {
    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: createResponse('https://example.com/protected', 403, {
          'content-type': 'text/html; charset=utf-8',
        }),
        cloudflareBypassed: false,
      }),
    })

    await assert.rejects(
      () =>
        tool.execute(
          'tool-1',
          { url: 'https://example.com/protected', format: 'html' },
          undefined,
          undefined,
        ),
      (error: unknown) => {
        const message = String((error as Error)?.message)
        assert.match(message, /Fetch failed: 403/)
        assert.match(message, /\[web_fetch_error\]/)
        assert.match(message, /code=http_error/)
        return true
      },
    )
  })

  it('refuses the jina fallback when a selector is set', async () => {
    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: createResponse('https://example.com/protected', 403, {
          'content-type': 'text/html; charset=utf-8',
        }),
        cloudflareBypassed: false,
      }),
    })

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
  })

  it('routes GitHub URLs through the GitHub handler without hitting the network', async () => {
    let networkCalls = 0
    const tool = buildFetchTool({
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
    })

    const result = await tool.execute(
      'tool-3',
      { url: 'https://github.com/owner/repo', format: 'markdown' },
      undefined,
      undefined,
    )
    assert.equal(networkCalls, 0)
    assert.equal(result.details.githubType, 'root')
  })

  it('redispatches to the GitHub handler after an HTTP redirect lands on github.com', async () => {
    let redirectedGithubCalls = 0
    const tool = buildFetchTool({
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
    })

    const result = await tool.execute(
      'tool-3b',
      { url: 'https://example.com/redirect-to-github', format: 'markdown' },
      undefined,
      undefined,
    )
    assert.equal(redirectedGithubCalls, 1)
    assert.equal(result.details.githubType, 'root')
    assert.equal(result.details.githubSource, 'api')
  })

  it('extracts PDF text when the response is application/pdf', async () => {
    let pdfCalls = 0
    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: {
          ...createResponse('https://example.com/spec.pdf', 200, {
            'content-type': 'application/pdf',
          }),
          bodyBuffer: Buffer.from('%PDF-1.4 fake'),
        },
        cloudflareBypassed: false,
      }),
      pdfTextExtractor: async () => {
        pdfCalls += 1
        return 'PDF body text'
      },
    })

    const result = await tool.execute(
      'tool-pdf',
      { url: 'https://example.com/spec.pdf', format: 'text' },
      undefined,
      undefined,
    )
    assert.equal(pdfCalls, 1)
    assert.equal(result.details.pdfExtracted, true)
    assert.match(getTextContent(result.content), /PDF body text/)
  })

  it('propagates custom headers and proxy through to networkFetcher', async () => {
    let receivedHeaders: Record<string, string> | undefined
    let receivedProxy: string | undefined
    const tool = buildFetchTool({
      networkFetcher: async (_url, _signal, _onUpdate, _requester, options) => {
        receivedHeaders = options?.headers
        receivedProxy = options?.proxy
        return {
          response: {
            ...createResponse('https://example.com/options', 200, {
              'content-type': 'text/plain; charset=utf-8',
            }),
            bodyBuffer: Buffer.from('request options body', 'utf8'),
          },
          cloudflareBypassed: false,
        }
      },
    })

    await tool.execute(
      'tool-options',
      {
        url: 'https://example.com/options',
        headers: { Authorization: 'Bearer token', 'X-Test-Header': 'hello' },
        proxy: 'http://proxy.example:8080',
      },
      undefined,
      undefined,
    )
    assert.equal(receivedHeaders?.Authorization, 'Bearer token')
    assert.equal(receivedHeaders?.['X-Test-Header'], 'hello')
    assert.equal(receivedProxy, 'http://proxy.example:8080/')

    await assert.rejects(
      () =>
        tool.execute(
          'tool-options-invalid-proxy',
          { url: 'https://example.com/options', proxy: 'ftp://proxy.example:21' },
          undefined,
          undefined,
        ),
      /Unsupported proxy protocol/,
    )
  })

  it('decodes a gzip-encoded latin-1 response correctly', async () => {
    const tool = buildFetchTool({
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
    })

    const result = await tool.execute(
      'tool-latin1',
      { url: 'https://example.com/latin1', format: 'text' },
      undefined,
      undefined,
    )
    assert.match(getTextContent(result.content), /café/)
  })

  it('rejects selector + non-HTML response with a helpful error', async () => {
    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: {
          ...createResponse('https://example.com/text', 200, {
            'content-type': 'text/plain; charset=utf-8',
          }),
          bodyBuffer: Buffer.from('plain text body', 'utf8'),
        },
        cloudflareBypassed: false,
      }),
    })

    await assert.rejects(
      () =>
        tool.execute(
          'tool-selector-bad',
          { url: 'https://example.com/text', format: 'text', selector: 'main' },
          undefined,
          undefined,
        ),
      /Selector is only supported for HTML responses/,
    )
  })

  it('falls back to Jina Reader on retryable status codes', async () => {
    let jinaUrl = ''
    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: createResponse('https://example.com/final-login', 403, {
          'content-type': 'text/html; charset=utf-8',
        }),
        cloudflareBypassed: false,
      }),
      jinaFetcher: async (sourceUrl) => {
        jinaUrl = sourceUrl.toString()
        return {
          response: createResponse('https://r.jina.ai/http://example.com', 200),
          content: 'status fallback content',
        }
      },
    })

    await tool.execute(
      'tool-jina-status',
      { url: 'https://example.com/start', format: 'markdown' },
      undefined,
      undefined,
    )
    assert.equal(jinaUrl, 'https://example.com/final-login')
  })

  it('falls back to Jina Reader when extraction yields shell content', async () => {
    let jinaUrl = ''
    const tool = buildFetchTool({
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
        jinaUrl = sourceUrl.toString()
        return {
          response: createResponse('https://r.jina.ai/http://example.com', 200),
          content: 'junk fallback content',
        }
      },
    })

    await tool.execute(
      'tool-jina-junk',
      { url: 'https://example.com/original', format: 'text' },
      undefined,
      undefined,
    )
    assert.equal(jinaUrl, 'https://example.com/final-page')
  })

  it('streams attachment responses to a temp file', async () => {
    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: {
          ...createResponse('https://example.com/archive', 200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="archive.bin"',
          }),
          bodyBuffer: Buffer.from([10, 20, 30, 40, 50]),
        },
        cloudflareBypassed: false,
      }),
    })

    const result = await tool.execute(
      'tool-binary',
      { url: 'https://example.com/archive' },
      undefined,
      undefined,
    )
    const { details } = result
    assert.equal(details.isFile, true)
    assert.equal(details.fileName, 'archive.bin')
    assert.equal(details.fileSize, 5)
    assert.ok(details.filePath)
    assert.equal(existsSync(details.filePath!), true)
    assert.deepEqual(readFileSync(details.filePath!), Buffer.from([10, 20, 30, 40, 50]))
    rmSync(details.filePath!, { force: true })
  })

  it('reuses a pre-downloaded file path when network supplies one', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-pre-'))
    const existingFilePath = path.join(tempDir, 'existing.bin')
    writeFileSync(existingFilePath, Buffer.from([1, 2, 3]))

    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: {
          ...createResponse('https://example.com/existing', 200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="existing.bin"',
          }),
          bodyBuffer: Buffer.alloc(0),
          downloadedFilePath: existingFilePath,
          downloadedFileSize: 3,
        },
        cloudflareBypassed: false,
      }),
    })

    try {
      const result = await tool.execute(
        'tool-pre',
        { url: 'https://example.com/existing' },
        undefined,
        undefined,
      )
      assert.equal(result.details.filePath, existingFilePath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('cleans up the streamed file when the response turns out to be non-ok', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-leak-'))
    const leakedFilePath = path.join(tempDir, 'leak.bin')
    writeFileSync(leakedFilePath, Buffer.from([99, 100, 101]))

    const tool = buildFetchTool({
      networkFetcher: async () => ({
        response: {
          ...createResponse('https://example.com/failed-download', 418, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="failed.bin"',
          }),
          ok: false,
          bodyBuffer: Buffer.alloc(0),
          downloadedFilePath: leakedFilePath,
          downloadedFileSize: 3,
        },
        cloudflareBypassed: false,
      }),
    })

    await assert.rejects(
      () =>
        tool.execute(
          'tool-cleanup',
          { url: 'https://example.com/failed-download' },
          undefined,
          undefined,
        ),
      /Fetch failed: 418/,
    )
    assert.equal(existsSync(leakedFilePath), false)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('does not cache image responses (refetches on repeat)', async () => {
    let networkCalls = 0
    const tool = buildFetchTool({
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
    })

    await tool.execute(
      'tool-image-1',
      { url: 'https://example.com/image.png' },
      undefined,
      undefined,
    )
    await tool.execute(
      'tool-image-2',
      { url: 'https://example.com/image.png' },
      undefined,
      undefined,
    )
    assert.equal(networkCalls, 2)
  })
})

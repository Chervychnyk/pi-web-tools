import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createGetWebContentTool } from '../get-web-content.ts'
import { createListWebContentTool } from '../list-web-content.ts'
import { getTextContent } from './helpers.ts'
import {
  getStorageRootCandidates,
  getStoredWebResponse,
  listStoredWebResponses,
  resolveStorageRoot,
  sliceStoredText,
  storeWebResponse,
  tryStoreWebResponse,
} from '../storage.ts'

describe('storage: storeWebResponse / getStoredWebResponse', () => {
  let storageDir: string
  let previousStorageDir: string | undefined
  let previousMaxAge: string | undefined

  beforeEach(() => {
    previousStorageDir = process.env.PI_WEB_TOOLS_STORAGE_DIR
    previousMaxAge = process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS
    storageDir = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-test-'))
    process.env.PI_WEB_TOOLS_STORAGE_DIR = storageDir
  })

  afterEach(() => {
    if (previousStorageDir === undefined) delete process.env.PI_WEB_TOOLS_STORAGE_DIR
    else process.env.PI_WEB_TOOLS_STORAGE_DIR = previousStorageDir
    if (previousMaxAge === undefined) delete process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS
    else process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS = previousMaxAge
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('stores and reloads a search response by id', () => {
    const stored = storeWebResponse({
      kind: 'search',
      requestedProvider: 'auto',
      queries: ['alpha', 'beta'],
      queryResults: [
        {
          query: 'alpha',
          provider: 'duckduckgo',
          count: 1,
          results: [{ title: 'Alpha', url: 'https://alpha.test', snippet: 'One' }],
          attempts: [{ provider: 'duckduckgo', ok: true, durationMs: 12, count: 1 }],
          fallbackUsed: false,
          durationMs: 12,
        },
        {
          query: 'beta',
          provider: 'duckduckgo',
          count: 0,
          results: [],
          attempts: [{ provider: 'duckduckgo', ok: true, durationMs: 8, count: 0 }],
          fallbackUsed: false,
          durationMs: 8,
        },
      ],
    })

    assert.equal(stored.kind, 'search')
    assert.ok(stored.responseId.startsWith('wt_'))
    assert.equal(getStoredWebResponse(stored.responseId)?.kind, 'search')
  })

  it('counts lines and chars for fetch responses', () => {
    const stored = storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/docs',
      finalUrl: 'https://example.com/docs',
      format: 'markdown',
      title: 'Example Docs',
      selectedSelector: 'main',
      contentType: 'text/html',
      messageText: '# Example Docs\n\nLine 1\nLine 2\nLine 3',
    })
    const loaded = getStoredWebResponse(stored.responseId)
    assert.equal(loaded?.kind, 'fetch')
    assert.equal(loaded?.lineCount, 5)
    assert.equal(loaded?.charCount, '# Example Docs\n\nLine 1\nLine 2\nLine 3'.length)
    assert.ok(loaded?.contentHash)
  })

  it('lists stored responses and respects the limit', () => {
    storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      format: 'text',
      messageText: 'a',
    })
    storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/b',
      finalUrl: 'https://example.com/b',
      format: 'text',
      messageText: 'b',
    })

    const listed = listStoredWebResponses({ limit: 1 })
    assert.equal(listed.length, 1)
  })

  it('reports lineCount=0 for empty content', () => {
    const stored = storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/empty',
      finalUrl: 'https://example.com/empty',
      format: 'text',
      messageText: '',
    })
    assert.equal(getStoredWebResponse(stored.responseId)?.lineCount, 0)
  })

  it('prunes stale responses based on PI_WEB_TOOLS_STORAGE_MAX_AGE_MS', () => {
    process.env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS = '1'
    const stale = storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/stale',
      finalUrl: 'https://example.com/stale',
      format: 'text',
      messageText: 'stale content',
    })
    const stalePath = path.join(storageDir, 'responses', `${stale.responseId}.json`)
    utimesSync(stalePath, new Date(0), new Date(0))

    storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/fresh',
      finalUrl: 'https://example.com/fresh',
      format: 'text',
      messageText: 'fresh content',
    })

    assert.equal(getStoredWebResponse(stale.responseId), undefined)
  })

  it('tryStoreWebResponse returns undefined instead of throwing when the dir is unwritable', () => {
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
  })
})

describe('storage root resolution (config-driven)', () => {
  it('picks env.PI_WEB_TOOLS_STORAGE_DIR over config.storageDir', () => {
    const candidates = getStorageRootCandidates(
      { PI_WEB_TOOLS_STORAGE_DIR: '/from-env' } as never,
      { storageDir: '/from-config' },
    )
    assert.equal(candidates[0], '/from-env')
  })

  it('uses config.storageDir when env is unset', () => {
    const candidates = getStorageRootCandidates(
      {} as never,
      { storageDir: '/from-config' },
    )
    assert.equal(candidates[0], '/from-config')
  })

  it('expands `~` in config.storageDir', () => {
    const candidates = getStorageRootCandidates(
      {} as never,
      { storageDir: '~/cache/web' },
    )
    assert.ok(
      candidates[0]?.endsWith('cache/web'),
      `expected resolved homedir path, got ${candidates[0]}`,
    )
    assert.ok(!candidates[0]?.startsWith('~'), 'tilde was expanded')
  })

  it('caches the resolved storage root by (env, config) shape', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-cfg-cache-'))
    try {
      const first = resolveStorageRoot(
        { PI_WEB_TOOLS_STORAGE_DIR: dir } as never,
        {},
      )
      const second = resolveStorageRoot(
        { PI_WEB_TOOLS_STORAGE_DIR: dir } as never,
        {},
      )
      assert.equal(first, second, 'identical env+config → same cached object')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sliceStoredText', () => {
  it('returns the requested slice with hasMore + nextOffset', () => {
    assert.deepEqual(sliceStoredText('a\nb\nc', 2, 1), {
      text: 'b',
      offset: 2,
      limit: 1,
      returnedLines: 1,
      totalLines: 3,
      hasMore: true,
      nextOffset: 3,
    })
  })

  it('reports hasMore=false on the final slice', () => {
    const finalSlice = sliceStoredText('a\nb\nc', 3, 1)
    assert.equal(finalSlice.hasMore, false)
    assert.equal(finalSlice.nextOffset, undefined)
  })

  it('throws when offset exceeds totalLines', () => {
    assert.throws(() => sliceStoredText('a\nb', 3, 1), /Offset 3 is beyond/)
  })
})

describe('get_web_content tool', () => {
  it('renders stored fetch responses with source URL + title + body slice', async () => {
    const stored = storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/old-docs',
      finalUrl: 'https://example.com/docs',
      format: 'markdown',
      title: 'Example Docs',
      messageText: '# Example Docs\n\nLine 1',
    })

    const tool = createGetWebContentTool()
    const result = await tool.execute(
      'content-tool-fetch',
      { responseId: stored.responseId, offset: 1, limit: 2 },
      undefined,
      undefined,
    )
    const text = getTextContent(result.content)
    assert.match(text, /Source URL: https:\/\/example\.com\/docs/)
    assert.match(text, /Requested URL: https:\/\/example\.com\/old-docs/)
    assert.match(text, /Title: Example Docs/)
    assert.match(text, /# Example Docs/)
  })

  it('selects a single query from a stored multi-query search', async () => {
    const stored = storeWebResponse({
      kind: 'search',
      requestedProvider: 'auto',
      queries: ['duplicate', 'duplicate'],
      queryResults: [
        {
          query: 'duplicate',
          provider: 'duckduckgo',
          count: 2,
          results: [
            { title: 'First A', url: 'https://first-a.test' },
            { title: 'First B', url: 'https://first-b.test' },
          ],
          attempts: [{ provider: 'duckduckgo', ok: true, durationMs: 10, count: 2 }],
          fallbackUsed: false,
          durationMs: 10,
        },
        {
          query: 'duplicate',
          provider: 'duckduckgo',
          count: 1,
          results: [{ title: 'Second', url: 'https://second.test' }],
          attempts: [{ provider: 'duckduckgo', ok: true, durationMs: 8, count: 1 }],
          fallbackUsed: false,
          durationMs: 8,
        },
      ],
    })

    const tool = createGetWebContentTool()
    const result = await tool.execute(
      'content-tool-multi-query',
      { responseId: stored.responseId, queryIndex: 1, offset: 1, limit: 1 },
      undefined,
      undefined,
    )
    const text = getTextContent(result.content)
    assert.match(text, /Result count: 1/)
    assert.match(text, /Query index: 1/)
    assert.match(text, /queryIndex: 1/)
    assert.doesNotMatch(text, /Result count: 3/)
  })

  it('paginates within a query result list', async () => {
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
            { title: 'Alpha Result', url: 'https://alpha.test', snippet: 'Example snippet' },
          ],
          attempts: [{ provider: 'duckduckgo', ok: true, durationMs: 10, count: 1 }],
          fallbackUsed: false,
          durationMs: 10,
        },
      ],
    })

    const result = await createGetWebContentTool().execute(
      'content-tool-1',
      { responseId: stored.responseId, query: 'alpha', offset: 1, limit: 1 },
      undefined,
      undefined,
    )
    const { details } = result
    const text = getTextContent(result.content)

    assert.equal(details.selectedQuery, 'alpha')
    assert.equal(details.returnedLines, 1)
    assert.equal(details.hasMore, true)
    assert.equal(details.nextOffset, 2)
    assert.match(text, /Search query: alpha/)
    assert.match(text, /Continue with: get_web_content/)
  })

  it('supports legacy stored responses with top-level messageText', async () => {
    const tool = createGetWebContentTool({
      loadStoredResponse: () => ({
        kind: 'search',
        responseId: 'wt_legacy',
        createdAt: new Date().toISOString(),
        requestedProvider: 'auto',
        queries: ['legacy'],
        queryResults: [
          {
            query: 'legacy',
            provider: 'duckduckgo',
            count: 1,
            results: [
              { title: 'Legacy Result', url: 'https://legacy.test', snippet: 'Legacy snippet' },
            ],
            attempts: [{ provider: 'duckduckgo', ok: true, durationMs: 10, count: 1 }],
            fallbackUsed: false,
            durationMs: 10,
            messageText: 'legacy message text',
          },
        ],
        messageText: 'legacy top-level text',
      }),
    })

    const result = await tool.execute(
      'content-tool-legacy',
      { responseId: 'wt_legacy' },
      undefined,
      undefined,
    )
    const text = getTextContent(result.content)
    assert.match(text, /Legacy Result/)
    assert.match(text, /https:\/\/legacy.test/)
  })
})

describe('list_web_content tool', () => {
  it('lists recent stored responses without leaking payload fields', async () => {
    storeWebResponse({
      kind: 'fetch',
      requestUrl: 'https://example.com/listed',
      finalUrl: 'https://example.com/listed',
      format: 'markdown',
      title: 'Listed',
      messageText: 'body',
    })

    const result = await createListWebContentTool().execute(
      'list-content-tool-1',
      { kind: 'fetch', limit: 5 },
      undefined,
      undefined,
    )
    const text = getTextContent(result.content)
    const { details } = result

    assert.match(text, /Stored web content:/)
    assert.match(text, /Retrieve: get_web_content/)
    assert.equal('messageText' in details.items[0]!, false)
    assert.equal('results' in details.items[0]!, false)
  })
})

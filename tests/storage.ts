import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGetWebContentTool, type GetWebContentDetails } from '../get-web-content.ts'
import {
  getStoredWebResponse,
  sliceStoredText,
  storeWebResponse,
  tryStoreWebResponse,
} from '../storage.ts'

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
        },
      ],
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
      },
    ],
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

async function testLegacySearchStorageCompatibility() {
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
            {
              title: 'Legacy Result',
              url: 'https://legacy.test',
              snippet: 'Legacy snippet',
            },
          ],
          attempts: [
            { provider: 'duckduckgo', ok: true, durationMs: 10, count: 1 },
          ],
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

  const content = result.content[0] as { type: 'text'; text: string }
  assert.match(content.text, /Legacy Result/)
  assert.match(content.text, /https:\/\/legacy.test/)
}

export async function runStorageTests() {
  testStoredResponseHelpers()
  await testGetWebContentExecutePaths()
  await testLegacySearchStorageCompatibility()
}

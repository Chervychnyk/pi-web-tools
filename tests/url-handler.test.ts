import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { beforeEach, describe, it } from 'node:test'
import { clearToolCache } from '../utils/cache.ts'
import {
  createWebFetchTool,
  type FetchResult,
  type UrlHandler,
} from '../web-fetch.ts'
import { createResponse, getTextContent } from './helpers.ts'

function staticTextResult(url: string, text: string): FetchResult {
  return {
    content: [{ type: 'text', text }],
    details: {
      url,
      format: 'markdown',
      truncated: false,
      cached: false,
      cacheAgeMs: 0,
    } as never,
  }
}

describe('UrlHandler dispatch', () => {
  beforeEach(() => clearToolCache())

  it('routes a URL to the first prepended handler that matches and validates', async () => {
    let fetchedBy: string | undefined
    const matchHandler: UrlHandler = {
      name: 'match',
      match: (url) => url.hostname === 'match.example',
      validate() {},
      async fetch(ctx) {
        fetchedBy = 'match'
        return staticTextResult(ctx.url.toString(), 'matched body')
      },
    }
    const tool = createWebFetchTool({
      urlHandlers: [matchHandler],
      networkFetcher: () => {
        throw new Error('default HTTP handler should not run for matched URL')
      },
    } as never)

    const result = await tool.execute(
      'tool-match',
      { url: 'https://match.example/' },
      undefined,
      undefined,
    )
    assert.equal(fetchedBy, 'match')
    assert.equal(
      getTextContent(result.content),
      'matched body',
    )
  })

  it('falls through to the next handler when fetch returns null', async () => {
    const order: string[] = []
    const firstHandler: UrlHandler = {
      name: 'first',
      match: () => true,
      validate() {},
      async fetch() {
        order.push('first')
        return null
      },
    }
    const secondHandler: UrlHandler = {
      name: 'second',
      match: () => true,
      validate() {},
      async fetch(ctx) {
        order.push('second')
        return staticTextResult(ctx.url.toString(), 'second body')
      },
    }
    const tool = createWebFetchTool({
      urlHandlers: [firstHandler, secondHandler],
      networkFetcher: () => {
        throw new Error('http handler should not be reached')
      },
    } as never)

    await tool.execute(
      'tool-fallthrough',
      { url: 'https://example.com/' },
      undefined,
      undefined,
    )
    assert.deepEqual(order, ['first', 'second'])
  })

  it('propagates validate errors strictly on the entry-point dispatch', async () => {
    const strictHandler: UrlHandler = {
      name: 'strict',
      match: () => true,
      validate() {
        throw new Error('selector is not supported here')
      },
      async fetch() {
        return null
      },
    }
    const tool = createWebFetchTool({
      urlHandlers: [strictHandler],
      networkFetcher: () => {
        throw new Error('http handler should not be reached')
      },
    } as never)

    await assert.rejects(
      () =>
        tool.execute(
          'tool-validate',
          { url: 'https://example.com/', selector: 'main' },
          undefined,
          undefined,
        ),
      /selector is not supported here/,
    )
  })

  it('silently skips a validate-throwing handler on re-dispatch (soft validate)', async () => {
    let strictValidates = 0
    let httpCalls = 0
    const strictAfterRedirect: UrlHandler = {
      name: 'strict-after-redirect',
      match: (url) => url.hostname === 'special.example',
      validate() {
        strictValidates += 1
        throw new Error('strict handler refuses this request')
      },
      async fetch() {
        throw new Error('strict.fetch should never run when validate throws')
      },
    }
    const tool = createWebFetchTool({
      urlHandlers: [strictAfterRedirect],
      networkFetcher: async () => {
        httpCalls += 1
        return {
          response: {
            ...createResponse('https://special.example/', 200, {
              'content-type': 'text/plain; charset=utf-8',
            }),
            bodyBuffer: Buffer.from('http body content', 'utf8'),
          },
          cloudflareBypassed: false,
        }
      },
    } as never)

    const result = await tool.execute(
      'tool-soft-validate',
      { url: 'https://example.com/', format: 'text' },
      undefined,
      undefined,
    )

    assert.equal(strictValidates, 1, 'strict validate fired post-redirect')
    assert.equal(httpCalls, 1, 'HTTP fetched exactly once — no duplicate fetch')
    assert.match(
      getTextContent(result.content),
      /http body content/,
      'HTTP continued with its body when dispatch returned null',
    )
  })

  it('throws on dispatch depth > 1 (cycle guard)', async () => {
    // Build a chain: handlerA dispatches to handlerB; handlerB tries to
    // dispatch again. Depth limit should throw.
    const handlerA: UrlHandler = {
      name: 'a',
      match: (url) => url.hostname === 'a.example',
      validate() {},
      async fetch(ctx) {
        return ctx.dispatch(new URL('https://b.example/'))
      },
    }
    const handlerB: UrlHandler = {
      name: 'b',
      match: (url) => url.hostname === 'b.example',
      validate() {},
      async fetch(ctx) {
        // This re-dispatch is at depth=2 → must throw.
        return ctx.dispatch(new URL('https://c.example/'))
      },
    }
    const handlerC: UrlHandler = {
      name: 'c',
      match: (url) => url.hostname === 'c.example',
      validate() {},
      async fetch() {
        return staticTextResult('https://c.example/', 'c body')
      },
    }
    const tool = createWebFetchTool({
      urlHandlers: [handlerA, handlerB, handlerC],
      networkFetcher: () => {
        throw new Error('http should not be reached')
      },
    } as never)

    await assert.rejects(
      () =>
        tool.execute(
          'tool-cycle',
          { url: 'https://a.example/' },
          undefined,
          undefined,
        ),
      /UrlHandler dispatch loop/,
    )
  })

  it('excludes the calling handler from ctx.dispatch (no self re-entry)', async () => {
    // If a custom handler matches every URL, ctx.dispatch on a redirected URL
    // must not route back to the same handler. With only one custom handler
    // registered, the call falls through to DefaultHttpHandler (always
    // appended), which is the right place for unspecialised URLs.
    let selfCalls = 0
    let httpCalls = 0
    const selfDispatcher: UrlHandler = {
      name: 'self',
      match: () => true,
      validate() {},
      async fetch(ctx) {
        selfCalls += 1
        const downstream = await ctx.dispatch(new URL('https://other.example/'))
        return downstream ?? staticTextResult(ctx.url.toString(), 'self body')
      },
    }
    const tool = createWebFetchTool({
      urlHandlers: [selfDispatcher],
      networkFetcher: async () => {
        httpCalls += 1
        return {
          response: {
            ...createResponse('https://other.example/', 200, {
              'content-type': 'text/plain; charset=utf-8',
            }),
            bodyBuffer: Buffer.from('http picked up', 'utf8'),
          },
          cloudflareBypassed: false,
        }
      },
    } as never)

    const result = await tool.execute(
      'tool-exclude-self',
      { url: 'https://example.com/' },
      undefined,
      undefined,
    )
    assert.equal(selfCalls, 1, 'self handler invoked exactly once (no re-entry)')
    assert.equal(httpCalls, 1, 'dispatch routed to HTTP catch-all instead')
    assert.match(
      getTextContent(result.content),
      /http picked up/,
    )
  })

  it('always appends DefaultHttpHandler so HTTP is the catch-all', async () => {
    let httpCalls = 0
    const noMatchHandler: UrlHandler = {
      name: 'never-matches',
      match: () => false,
      validate() {},
      async fetch() {
        return staticTextResult('', 'unreachable')
      },
    }
    const tool = createWebFetchTool({
      urlHandlers: [noMatchHandler],
      networkFetcher: async () => {
        httpCalls += 1
        return {
          response: {
            ...createResponse('https://example.com/', 200, {
              'content-type': 'text/plain; charset=utf-8',
            }),
            bodyBuffer: Buffer.from('http reached', 'utf8'),
          },
          cloudflareBypassed: false,
        }
      },
    } as never)

    const result = await tool.execute(
      'tool-default',
      { url: 'https://example.com/', format: 'text' },
      undefined,
      undefined,
    )
    assert.equal(httpCalls, 1)
    assert.match(getTextContent(result.content), /http reached/)
  })
})

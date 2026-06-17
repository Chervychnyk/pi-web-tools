import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { beforeEach, describe, it } from 'node:test'
import { clearToolCache } from '../utils/cache.ts'
import { buildBatchFetchTool, createResponse } from './helpers.ts'

describe('createBatchWebFetchTool', () => {
  beforeEach(() => clearToolCache())

  it('runs every request, preserves input order, and surfaces per-item status', async () => {
    const tool = buildBatchFetchTool({
      networkFetcher: async (url) => {
        if (url.toString().includes('failure')) {
          return {
            response: createResponse(url.toString(), 500, {
              'content-type': 'text/html; charset=utf-8',
            }),
            cloudflareBypassed: false,
          }
        }
        return {
          response: {
            ...createResponse(url.toString(), 200, {
              'content-type': 'text/plain; charset=utf-8',
            }),
            bodyBuffer: Buffer.from(`content for ${url.toString()}`, 'utf8'),
          },
          cloudflareBypassed: false,
        }
      },
    })

    const result = await tool.execute(
      'batch-tool-1',
      {
        requests: [
          { url: 'https://example.com/alpha', format: 'text' },
          { url: 'https://example.com/failure', format: 'html' },
          { url: 'https://example.com/gamma', format: 'markdown' },
        ],
        concurrency: 2,
      },
      undefined,
      undefined,
    )

    const details = result.details as {
      total: number
      succeeded: number
      failed: number
      completed: number
      concurrency: number
      items: Array<{
        index: number
        url: string
        status: string
        errorCode?: string
        errorPhase?: string
        retryable?: boolean
      }>
    }

    assert.equal(details.total, 3)
    assert.equal(details.completed, 3)
    assert.equal(details.succeeded, 2)
    assert.equal(details.failed, 1)
    assert.equal(details.concurrency, 2)

    // Order is preserved by index regardless of completion order.
    assert.equal(details.items[0]?.url, 'https://example.com/alpha')
    assert.equal(details.items[1]?.url, 'https://example.com/failure')
    assert.equal(details.items[2]?.url, 'https://example.com/gamma')
    assert.equal(details.items[1]?.status, 'error')
    assert.equal(details.items[1]?.errorCode, 'http_error')
    assert.equal(details.items[1]?.errorPhase, 'response')
    assert.equal(details.items[1]?.retryable, true)
  })
})

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { appendStoredResponseNote } from '../shared.ts'
import {
  buildCacheKey,
  clearToolCache,
  getCachedValue,
  setCachedValue,
} from '../utils/cache.ts'

describe('utils/cache', () => {
  beforeEach(() => clearToolCache())

  it('stableSerialize produces equal keys regardless of property order', () => {
    const keyA = buildCacheKey({ b: 2, a: 1, list: ['x', { z: 1, y: 2 }] })
    const keyB = buildCacheKey({ a: 1, list: ['x', { y: 2, z: 1 }], b: 2 })
    assert.equal(keyA, keyB)
  })

  it('returns the value with elapsed age when within TTL', () => {
    setCachedValue('cache:test', { value: 1 }, 1000, 100)
    assert.deepEqual(getCachedValue<{ value: number }>('cache:test', 150), {
      value: { value: 1 },
      ageMs: 50,
    })
  })

  it('treats a value past its TTL as absent', () => {
    setCachedValue('cache:test', { value: 1 }, 1000, 100)
    assert.equal(getCachedValue('cache:test', 1200), undefined)
  })
})

describe('appendStoredResponseNote', () => {
  it('returns the content unchanged when no responseId is supplied', () => {
    assert.equal(appendStoredResponseNote('hello'), 'hello')
  })

  it('appends a retrieval footer when responseId is supplied', () => {
    const out = appendStoredResponseNote('hello', 'rsp_x', 'get_web_content', {
      source: 'https://example.com',
      label: 'URL',
    })
    assert.match(out, /responseId: rsp_x/)
    assert.match(out, /URL: https:\/\/example\.com/)
    assert.match(out, /Retrieve: get_web_content/)
  })
})

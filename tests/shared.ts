import assert from 'node:assert/strict'
import {
  appendStoredResponseNote,
  buildCacheKey,
  getCachedValue,
  setCachedValue,
} from '../shared.ts'

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

export async function runSharedTests() {
  testCacheHelpers()
}

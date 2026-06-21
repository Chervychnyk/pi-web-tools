import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  getCacheDirCandidates,
  resolveCachePath,
} from '../utils/writable-dir.ts'

describe('resolveCachePath', () => {
  it('expands a bare `~` to the home directory', () => {
    assert.equal(resolveCachePath('~'), homedir())
  })

  it('expands `~/...` paths to homedir-relative', () => {
    assert.equal(resolveCachePath('~/cache/web'), path.join(homedir(), 'cache/web'))
  })

  it('resolves absolute paths unchanged', () => {
    assert.equal(resolveCachePath('/var/tmp/pi'), '/var/tmp/pi')
  })

  it('resolves relative paths against cwd', () => {
    assert.equal(resolveCachePath('./cache'), path.resolve('./cache'))
  })
})

describe('getCacheDirCandidates', () => {
  it('uses only the explicit dir when set', () => {
    const candidates = getCacheDirCandidates({
      explicitDir: '~/explicit',
      defaultDir: '/default',
      xdgDir: '/xdg',
      fallbackDir: '/fallback',
    })
    assert.deepEqual(candidates, [path.join(homedir(), 'explicit')])
  })

  it('falls back through default → xdg → fallback when no explicit dir', () => {
    const candidates = getCacheDirCandidates({
      defaultDir: '/default',
      xdgDir: '/xdg',
      fallbackDir: '/fallback',
    })
    assert.deepEqual(candidates, ['/default', '/xdg', '/fallback'])
  })

  it('omits xdg when not configured', () => {
    const candidates = getCacheDirCandidates({
      defaultDir: '/default',
      fallbackDir: '/fallback',
    })
    assert.deepEqual(candidates, ['/default', '/fallback'])
  })

  it('dedupes duplicate paths in the candidate list', () => {
    const candidates = getCacheDirCandidates({
      defaultDir: '/same',
      xdgDir: '/same',
      fallbackDir: '/different',
    })
    assert.deepEqual(candidates, ['/same', '/different'])
  })
})

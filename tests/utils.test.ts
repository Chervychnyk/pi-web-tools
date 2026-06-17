import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compactUrl,
  formatDuration,
  renderBadges,
} from '../utils/ui.ts'

// Strip-ANSI theme so assertions can compare plain text.
const flatTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never

describe('compactUrl', () => {
  it('strips https:// and trailing slash', () => {
    assert.equal(compactUrl('https://example.com/'), 'example.com')
    assert.equal(compactUrl('https://example.com/path'), 'example.com/path')
  })

  it('strips http:// as well', () => {
    assert.equal(compactUrl('http://example.com/path'), 'example.com/path')
  })

  it('leaves other protocols intact', () => {
    assert.equal(compactUrl('ftp://example.com/x'), 'ftp://example.com/x')
  })

  it('passes empty / undefined-ish strings through', () => {
    assert.equal(compactUrl(''), '')
  })
})

describe('formatDuration', () => {
  it('renders sub-second as ms', () => {
    assert.equal(formatDuration(0), '0ms')
    assert.equal(formatDuration(600), '600ms')
    assert.equal(formatDuration(999), '999ms')
  })

  it('renders whole seconds without a decimal', () => {
    assert.equal(formatDuration(1000), '1s')
    assert.equal(formatDuration(10_000), '10s')
    assert.equal(formatDuration(30_000), '30s')
  })

  it('renders fractional seconds with one decimal', () => {
    assert.equal(formatDuration(1500), '1.5s')
    assert.equal(formatDuration(2750), '2.8s')
  })

  it('renders whole minutes without a decimal', () => {
    assert.equal(formatDuration(60_000), '1m')
    assert.equal(formatDuration(180_000), '3m')
  })

  it('renders fractional minutes with one decimal', () => {
    assert.equal(formatDuration(90_000), '1.5m')
  })

  it('renders hours past 1h', () => {
    assert.equal(formatDuration(3_600_000), '1.0h')
    assert.equal(formatDuration(5_400_000), '1.5h')
  })

  it('falls through to ms for negative / NaN', () => {
    assert.equal(formatDuration(-1), '-1ms')
    assert.equal(formatDuration(Number.NaN), 'NaNms')
  })
})

describe('renderBadges', () => {
  it('returns empty string when no badge applies', () => {
    assert.equal(renderBadges(flatTheme, {}), '')
  })

  it('emits a bracketed group with positive → informative → negative order', () => {
    assert.equal(
      renderBadges(flatTheme, { cached: true, truncated: true, aborted: true }),
      ' [cached, truncated, aborted]',
    )
  })

  it('lists informative badges in declaration order', () => {
    assert.equal(
      renderBadges(flatTheme, {
        truncated: true,
        charLimited: true,
        cloudflareBypassed: true,
        fallbackUsed: true,
        extractionMethod: 'readability',
        selector: '#main',
      }),
      ' [truncated, chars-limited, cf-retry, fallback, readability, selector=#main]',
    )
  })

  it('renders just `cached` when only cached is set', () => {
    assert.equal(renderBadges(flatTheme, { cached: true }), ' [cached]')
  })
})

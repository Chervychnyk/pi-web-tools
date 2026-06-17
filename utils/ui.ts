import type { Theme } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { truncateText } from './truncate.ts'

export type BadgeDetails = {
  truncated?: boolean
  charLimited?: boolean
  selector?: string
  extractionMethod?: string
  cloudflareBypassed?: boolean
  fallbackUsed?: boolean
  aborted?: boolean
  cached?: boolean
}

// Three semantic categories so color carries signal rather than alarm:
//   accent  = positive (cached)
//   muted   = informative (truncated, fallback, selector, …)
//   warning = negative (aborted)
// Badges are wrapped in dim brackets so they read as a metadata group.
export function renderBadges(theme: Theme, details: BadgeDetails) {
  const parts: string[] = []

  if (details.cached) parts.push(theme.fg('accent', 'cached'))

  if (details.truncated) parts.push(theme.fg('muted', 'truncated'))
  if (details.charLimited) parts.push(theme.fg('muted', 'chars-limited'))
  if (details.cloudflareBypassed) parts.push(theme.fg('muted', 'cf-retry'))
  if (details.fallbackUsed) parts.push(theme.fg('muted', 'fallback'))
  if (details.extractionMethod)
    parts.push(theme.fg('muted', details.extractionMethod))
  if (details.selector)
    parts.push(theme.fg('muted', `selector=${details.selector}`))

  if (details.aborted) parts.push(theme.fg('warning', 'aborted'))

  if (!parts.length) return ''

  const sep = theme.fg('dim', ', ')
  return ` ${theme.fg('dim', '[')}${parts.join(sep)}${theme.fg('dim', ']')}`
}

export function renderToolCallHeader(
  toolName: string,
  primaryText: string,
  primaryMaxLength: number,
  parts: string[],
  theme: Theme,
) {
  let text = theme.fg('toolTitle', theme.bold(`${toolName} `))
  text += theme.fg('accent', truncateText(primaryText, primaryMaxLength))
  if (parts.length) text += theme.fg('dim', ` (${parts.join(' · ')})`)
  return new Text(text, 0, 0)
}

// Strip the protocol from a URL for display; preserves everything else.
// Used in tool-call headers where the host is the most informative part
// and `https://` is constant noise.
export function compactUrl(url: string): string {
  if (!url) return url
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

// Render a millisecond duration in human units.
//   600   -> '600ms'
//   1500  -> '1.5s'
//   10000 -> '10s'
//   90000 -> '1.5m'
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) {
    const seconds = ms / 1000
    return seconds % 1 === 0 ? `${seconds}s` : `${seconds.toFixed(1)}s`
  }
  if (ms < 3_600_000) {
    const minutes = ms / 60_000
    return minutes % 1 === 0 ? `${minutes}m` : `${minutes.toFixed(1)}m`
  }
  return `${(ms / 3_600_000).toFixed(1)}h`
}

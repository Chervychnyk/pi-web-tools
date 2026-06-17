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
  if (parts.length) text += theme.fg('dim', ` (${parts.join(', ')})`)
  return new Text(text, 0, 0)
}

import type { Theme } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { truncateText } from './truncate.ts'

export function renderBadges(
  theme: Theme,
  details: {
    truncated?: boolean
    charLimited?: boolean
    selector?: string
    extractionMethod?: string
    cloudflareBypassed?: boolean
    fallbackUsed?: boolean
    aborted?: boolean
    cached?: boolean
  },
) {
  const badges: string[] = []
  if (details.aborted) badges.push(theme.fg('warning', 'aborted'))
  if (details.cached) badges.push(theme.fg('accent', 'cached'))
  if (details.charLimited) badges.push(theme.fg('warning', 'chars-limited'))
  if (details.truncated) badges.push(theme.fg('warning', 'truncated'))
  if (details.cloudflareBypassed)
    badges.push(theme.fg('warning', 'cf-retry'))
  if (details.fallbackUsed)
    badges.push(theme.fg('warning', 'fallback'))
  if (details.extractionMethod)
    badges.push(theme.fg('muted', details.extractionMethod))
  if (details.selector)
    badges.push(theme.fg('muted', `selector=${details.selector}`))
  return badges.length ? ` ${badges.join(' ')}` : ''
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

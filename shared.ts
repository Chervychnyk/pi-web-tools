import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type Theme,
} from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export const DEFAULT_TIMEOUT = 10_000
export const DEFAULT_WEB_TOOLS_CACHE_DIR = path.join(
  homedir(),
  '.pi',
  'cache',
  'web-tools',
)
export const FALLBACK_WEB_TOOLS_CACHE_DIR = path.join(
  tmpdir(),
  'pi-web-tools-cache',
)

const TOOL_CACHE = new Map<
  string,
  { value: unknown; storedAt: number; expiresAt: number }
>()
const WRITABLE_CACHE_DIR_CACHE = new Map<
  string,
  { dir: string; fallbackUsed: boolean; attempted: string[] }
>()

export type TruncationResult = {
  text: string
  truncated: boolean
  tempFile?: string
  totalBytes: number
  totalLines: number
  maxChars?: number
  charLimited: boolean
  originalChars: number
}

export type CacheDirOptions = {
  explicitDir?: string
  defaultDir: string
  xdgDir?: string
  fallbackDir: string
}

export function normalizeHostname(hostname: string) {
  return hostname.trim().replace(/\.+$/g, '').toLowerCase()
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ *\n */g, '\n')
    .trim()
}

export function createAbortController(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController()
  let timedOut = false

  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  return {
    controller,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
    },
    rethrowIfAbort: (error: unknown, label: string) => {
      if ((error as Error).name === 'AbortError') {
        if (timedOut) {
          throw new Error(`${label} timed out after ${timeoutMs}ms`)
        }
        throw new Error(`${label} aborted`)
      }
      throw error
    },
  }
}

function writeTruncatedOutput(content: string, extension: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-'))
  const tempFile = path.join(tempDir, `content${extension}`)
  writeFileSync(tempFile, content, 'utf8')
  return tempFile
}

export function limitByChars(content: string, maxChars?: number) {
  const originalChars = content.length

  if (!maxChars) {
    return {
      content,
      maxChars: undefined,
      charLimited: false,
      originalChars,
    }
  }

  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`Invalid maxChars: ${maxChars}`)
  }

  if (content.length <= maxChars) {
    return {
      content,
      maxChars,
      charLimited: false,
      originalChars,
    }
  }

  return {
    content: `${content.slice(0, maxChars).trimEnd()}\n\n---\n[Character limit applied: showing first ${maxChars} of ${originalChars} characters]`,
    maxChars,
    charLimited: true,
    originalChars,
  }
}

export function truncateForModel(
  content: string,
  extension: string,
  maxChars?: number,
): TruncationResult {
  const limited = limitByChars(content, maxChars)
  const truncation = truncateHead(limited.content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  })

  if (!truncation.truncated) {
    return {
      text: limited.content,
      truncated: false,
      totalBytes: truncation.totalBytes,
      totalLines: truncation.totalLines,
      maxChars: limited.maxChars,
      charLimited: limited.charLimited,
      originalChars: limited.originalChars,
    }
  }

  const tempFile = writeTruncatedOutput(limited.content, extension)
  return {
    text: `${truncation.content}\n\n---\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]\nFull output saved to: ${tempFile}`,
    truncated: true,
    tempFile,
    totalBytes: truncation.totalBytes,
    totalLines: truncation.totalLines,
    maxChars: limited.maxChars,
    charLimited: limited.charLimited,
    originalChars: limited.originalChars,
  }
}

const MAX_CACHE_ENTRIES = 200
let lastPruneAt = 0

function pruneExpiredCacheEntries(now = Date.now()) {
  if (now - lastPruneAt < 1_000 && TOOL_CACHE.size <= MAX_CACHE_ENTRIES) return
  lastPruneAt = now

  for (const [key, entry] of TOOL_CACHE.entries()) {
    if (entry.expiresAt <= now) TOOL_CACHE.delete(key)
  }

  if (TOOL_CACHE.size > MAX_CACHE_ENTRIES) {
    const entries = [...TOOL_CACHE.entries()].sort(
      (a, b) => a[1].storedAt - b[1].storedAt,
    )
    const excess = entries.length - MAX_CACHE_ENTRIES
    for (let i = 0; i < excess; i++) {
      TOOL_CACHE.delete(entries[i]![0])
    }
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  )
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
    .join(',')}}`
}

export function buildCacheKey(parts: unknown) {
  return stableSerialize(parts)
}

export function getCachedValue<T>(key: string, now = Date.now()) {
  pruneExpiredCacheEntries(now)
  const entry = TOOL_CACHE.get(key)
  if (!entry || entry.expiresAt <= now) return undefined
  return {
    value: structuredClone(entry.value) as T,
    ageMs: Math.max(0, now - entry.storedAt),
  }
}

export function setCachedValue<T>(key: string, value: T, ttlMs: number, now = Date.now()) {
  pruneExpiredCacheEntries(now)
  TOOL_CACHE.set(key, {
    value: structuredClone(value),
    storedAt: now,
    expiresAt: now + ttlMs,
  })
}

function dedupeResolvedPaths(paths: string[]) {
  return [...new Set(paths.map((value) => path.resolve(value)))]
}

export function getCacheDirCandidates(options: CacheDirOptions) {
  const { explicitDir, defaultDir, xdgDir, fallbackDir } = options
  if (explicitDir?.trim()) {
    return [path.resolve(explicitDir)]
  }

  const candidates = [defaultDir]
  if (xdgDir?.trim()) candidates.push(xdgDir)
  candidates.push(fallbackDir)
  return dedupeResolvedPaths(candidates)
}

function canUseCacheDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true })
    const probePath = path.join(
      dir,
      `.pi-web-tools-probe-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
    )
    writeFileSync(probePath, 'ok', 'utf8')
    rmSync(probePath, { force: true })
    return true
  } catch {
    return false
  }
}

export function resolveWritableCacheDir(options: CacheDirOptions) {
  const candidates = getCacheDirCandidates(options)
  const cacheKey = candidates.join('\u0000')
  const cached = WRITABLE_CACHE_DIR_CACHE.get(cacheKey)
  if (cached) return cached

  for (const [index, dir] of candidates.entries()) {
    if (!canUseCacheDir(dir)) continue
    const resolved = {
      dir,
      fallbackUsed: index > 0,
      attempted: candidates,
    }
    WRITABLE_CACHE_DIR_CACHE.set(cacheKey, resolved)
    return resolved
  }

  throw new Error(
    `No writable cache directory found. Tried: ${candidates.join(', ')}`,
  )
}

export function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

export function appendStoredResponseNote(
  content: string,
  responseId?: string,
  toolName = 'get_web_content',
) {
  if (!responseId) return content

  return [
    content,
    '---',
    `[responseId: ${responseId}]`,
    `Use ${toolName}({ responseId: ${JSON.stringify(responseId)} }) to retrieve stored content.`,
  ].join('\n\n')
}

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

export function execFileAsync(
  command: string,
  args: string[],
  signal?: AbortSignal,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            stderr?.trim() || stdout?.trim() || error.message || `Failed to run ${command}`,
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })

    if (!signal) return
    const onAbort = () => child.kill('SIGTERM')
    if (signal.aborted) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('exit', () => signal.removeEventListener('abort', onAbort))
  })
}

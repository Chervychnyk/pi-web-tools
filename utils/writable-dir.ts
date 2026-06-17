import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

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

export type CacheDirOptions = {
  explicitDir?: string
  defaultDir: string
  xdgDir?: string
  fallbackDir: string
}

const WRITABLE_CACHE_DIR_CACHE = new Map<
  string,
  { dir: string; fallbackUsed: boolean; attempted: string[] }
>()

const CACHE_KEY_SEPARATOR = String.fromCharCode(0)

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
  const cacheKey = candidates.join(CACHE_KEY_SEPARATOR)
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

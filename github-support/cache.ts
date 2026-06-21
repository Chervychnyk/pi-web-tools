import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { getConfiguredValue, readWebToolsConfig } from '../config.ts'
import {
  DEFAULT_WEB_TOOLS_CACHE_DIR,
  FALLBACK_WEB_TOOLS_CACHE_DIR,
  getCacheDirCandidates,
  resolveCachePath,
  resolveWritableCacheDir,
} from '../utils/writable-dir.ts'
import { cloneGitHubRepo } from './git.ts'
import type {
  EnsureGitHubCloneResult,
  GitHubCacheEntry,
  GitHubUrlInfo,
} from './types.ts'

const DEFAULT_GITHUB_CACHE_DIR = path.join(
  DEFAULT_WEB_TOOLS_CACHE_DIR,
  'github',
)
const FALLBACK_GITHUB_CACHE_DIR = path.join(
  FALLBACK_WEB_TOOLS_CACHE_DIR,
  'github',
)
const DEFAULT_GITHUB_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const MAX_GITHUB_CACHE_REPOS = 40
const MAX_GITHUB_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000
const GITHUB_CACHE_METADATA_DIR_NAME = '.meta'
const CACHE_TOUCH_FILENAME = '.pi-web-tools-cache-touch'

const IN_FLIGHT_CLONES = new Map<string, Promise<EnsureGitHubCloneResult>>()

function getExplicitGitHubCacheDir(env: NodeJS.ProcessEnv = process.env) {
  const config = readWebToolsConfig()
  const githubDir = getConfiguredValue(env.PI_WEB_TOOLS_GITHUB_DIR, config.githubDir)
  if (githubDir) return resolveCachePath(githubDir)

  const storageDir = getConfiguredValue(env.PI_WEB_TOOLS_STORAGE_DIR, config.storageDir)
  if (storageDir) return path.join(resolveCachePath(storageDir), 'github')

  return undefined
}

function getXdgGitHubCacheDir(env: NodeJS.ProcessEnv = process.env) {
  if (!env.XDG_CACHE_HOME?.trim()) return undefined
  return path.join(resolveCachePath(env.XDG_CACHE_HOME), 'pi', 'web-tools', 'github')
}

function canUseGitHubCacheDir(dir: string) {
  const probePath = path.join(
    dir,
    `.pi-web-tools-git-probe-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
  )

  try {
    mkdirSync(path.join(probePath, '.git'), { recursive: true })
    writeFileSync(path.join(probePath, '.git', 'config'), 'ok\n', 'utf8')
    rmSync(probePath, { recursive: true, force: true })
    return true
  } catch {
    rmSync(probePath, { recursive: true, force: true })
    return false
  }
}

function resolveGitHubCacheDir(env: NodeJS.ProcessEnv = process.env) {
  const options = {
    explicitDir: getExplicitGitHubCacheDir(env),
    defaultDir: DEFAULT_GITHUB_CACHE_DIR,
    xdgDir: getXdgGitHubCacheDir(env),
    fallbackDir: FALLBACK_GITHUB_CACHE_DIR,
  }

  // The general web-tools cache probe only checks ordinary files. Under Pi's
  // sandbox, ~/.pi may be symlinked into the active dotfiles repo, where writes
  // below .git directories are blocked. GitHub cache entries are real clones, so
  // verify that the chosen cache can host a .git/config before cloning.
  const candidates = getCacheDirCandidates(options)
  for (const dir of candidates) {
    if (canUseGitHubCacheDir(dir)) {
      return {
        dir,
        fallbackUsed: dir !== path.resolve(options.defaultDir),
        attempted: candidates,
      }
    }
  }

  return resolveWritableCacheDir(options)
}

function repoCachePath(info: GitHubUrlInfo, cacheDir: string) {
  const refPart = info.ref ? `@${info.ref.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''
  return path.join(cacheDir, info.owner, `${info.repo}${refPart}`)
}

function getGitHubMetadataDir(rootPath: string) {
  return path.join(rootPath, GITHUB_CACHE_METADATA_DIR_NAME)
}

function getGitHubCacheTouchPath(rootPath: string, localPath: string) {
  const relativePath = path.relative(rootPath, localPath)
  return path.join(getGitHubMetadataDir(rootPath), relativePath, CACHE_TOUCH_FILENAME)
}

function getGitHubCacheLastUsedMs(rootPath: string, localPath: string) {
  const touchPath = getGitHubCacheTouchPath(rootPath, localPath)
  try {
    return statSync(touchPath).mtimeMs
  } catch {
    return statSync(localPath).mtimeMs
  }
}

function cleanupEmptyDirectories(startPath: string, stopPath: string) {
  let currentPath = path.dirname(startPath)
  const resolvedStopPath = path.resolve(stopPath)

  while (
    currentPath.startsWith(resolvedStopPath) &&
    currentPath !== resolvedStopPath
  ) {
    try {
      if (existsSync(currentPath) && readdirSync(currentPath).length === 0) {
        rmSync(currentPath, { recursive: true, force: true })
        currentPath = path.dirname(currentPath)
        continue
      }
    } catch {
      // Ignore metadata cleanup failures.
    }
    break
  }
}

function removeGitHubCacheTouch(rootPath: string, localPath: string) {
  const touchPath = getGitHubCacheTouchPath(rootPath, localPath)
  rmSync(touchPath, { force: true })
  cleanupEmptyDirectories(touchPath, getGitHubMetadataDir(rootPath))
}

function touchGitHubCache(rootPath: string, localPath: string) {
  const touchPath = getGitHubCacheTouchPath(rootPath, localPath)
  mkdirSync(path.dirname(touchPath), { recursive: true })
  writeFileSync(touchPath, `${new Date().toISOString()}\n`, 'utf8')
}

export function isGitHubCacheStale(
  lastUsedMs: number,
  now = Date.now(),
  ttlMs = DEFAULT_GITHUB_CACHE_TTL_MS,
) {
  return now - lastUsedMs > ttlMs
}

function collectGitHubCacheEntries(rootPath: string) {
  if (!existsSync(rootPath)) return []

  const entries: GitHubCacheEntry[] = []
  for (const owner of readdirSync(rootPath)) {
    if (owner === GITHUB_CACHE_METADATA_DIR_NAME) continue

    const ownerPath = path.join(rootPath, owner)
    if (!statSync(ownerPath).isDirectory()) continue

    for (const repoDir of readdirSync(ownerPath)) {
      const localPath = path.join(ownerPath, repoDir)
      const gitDir = path.join(localPath, '.git')
      if (!existsSync(gitDir) || !statSync(localPath).isDirectory()) continue

      entries.push({
        ownerPath,
        localPath,
        lastUsedMs: getGitHubCacheLastUsedMs(rootPath, localPath),
      })
    }
  }

  return entries.sort((left, right) => right.lastUsedMs - left.lastUsedMs)
}

export function pruneGitHubCacheDir(
  rootPath: string,
  options: {
    maxRepos?: number
    maxAgeMs?: number
    now?: number
  } = {},
) {
  const {
    maxRepos = MAX_GITHUB_CACHE_REPOS,
    maxAgeMs = MAX_GITHUB_CACHE_AGE_MS,
    now = Date.now(),
  } = options

  const entries = collectGitHubCacheEntries(rootPath)

  for (const [index, entry] of entries.entries()) {
    const expired = now - entry.lastUsedMs > maxAgeMs
    const overflow = index >= maxRepos
    if (!expired && !overflow) continue

    rmSync(entry.localPath, { recursive: true, force: true })
    removeGitHubCacheTouch(rootPath, entry.localPath)

    try {
      if (existsSync(entry.ownerPath) && readdirSync(entry.ownerPath).length === 0) {
        rmSync(entry.ownerPath, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup failures for parent directories.
    }
  }
}

export async function ensureGitHubClone(
  info: GitHubUrlInfo,
  signal?: AbortSignal,
  refresh = false,
): Promise<EnsureGitHubCloneResult> {
  if (info.refIsFullSha) {
    throw new Error(
      'GitHub blob/tree URLs pinned to a full commit SHA are not supported for local clone mode',
    )
  }

  const cacheDir = resolveGitHubCacheDir().dir
  const localPath = repoCachePath(info, cacheDir)
  const gitDir = path.join(localPath, '.git')
  let cacheStatus: EnsureGitHubCloneResult['cacheStatus'] = 'cloned'

  if (!refresh) {
    const inFlight = IN_FLIGHT_CLONES.get(localPath)
    if (inFlight) return inFlight
  }

  if (existsSync(gitDir)) {
    const stale = isGitHubCacheStale(getGitHubCacheLastUsedMs(cacheDir, localPath))

    if (refresh) {
      rmSync(localPath, { recursive: true, force: true })
      removeGitHubCacheTouch(cacheDir, localPath)
      cacheStatus = 'manual-refresh'
    } else if (stale) {
      rmSync(localPath, { recursive: true, force: true })
      removeGitHubCacheTouch(cacheDir, localPath)
      cacheStatus = 'stale-refresh'
    } else {
      touchGitHubCache(cacheDir, localPath)
      pruneGitHubCacheDir(cacheDir)
      return { localPath, cacheStatus: 'cached' }
    }
  }

  const clonePromise = (async () => {
    try {
      mkdirSync(path.dirname(localPath), { recursive: true })
      await cloneGitHubRepo(info, localPath, signal)
      touchGitHubCache(cacheDir, localPath)
      pruneGitHubCacheDir(cacheDir)
      return { localPath, cacheStatus }
    } catch (error) {
      rmSync(localPath, { recursive: true, force: true })
      removeGitHubCacheTouch(cacheDir, localPath)
      throw error
    }
  })()

  IN_FLIGHT_CLONES.set(localPath, clonePromise)

  try {
    return await clonePromise
  } finally {
    const active = IN_FLIGHT_CLONES.get(localPath)
    if (active === clonePromise) {
      IN_FLIGHT_CLONES.delete(localPath)
    }
  }
}

export function cleanupGitHubCache() {
  IN_FLIGHT_CLONES.clear()

  try {
    const { dir } = resolveGitHubCacheDir()
    pruneGitHubCacheDir(dir)
  } catch {
    // Best-effort — process is exiting.
  }
}

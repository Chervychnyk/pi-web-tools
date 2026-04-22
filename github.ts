import { ensureGitHubClone, isGitHubCacheStale, pruneGitHubCacheDir } from './github-support/cache.ts'
import { fetchGitHubContentViaApi } from './github-support/api.ts'
import { resolveGitHubUrlInfo } from './github-support/git.ts'
import {
  buildGitHubContentText,
  renderGitHubCloneStatus,
  resolveWithinRepo,
} from './github-support/render.ts'
import type { GitHubFetchResult, GitHubUrlInfo } from './github-support/types.ts'
import { parseGitHubUrl, resolveGitHubRefPath } from './github-support/url.ts'

export type { GitHubFetchResult, GitHubUrlInfo } from './github-support/types.ts'
export { isGitHubCacheStale, parseGitHubUrl, pruneGitHubCacheDir, resolveGitHubRefPath, resolveWithinRepo }

function isResolvableRefPath(info: GitHubUrlInfo) {
  return (
    info.type !== 'root' &&
    !info.refIsFullSha &&
    Boolean(info.refPathSegments && info.refPathSegments.length > 1)
  )
}

function buildCanonicalGitHubUrl(info: GitHubUrlInfo, fallbackUrl: string) {
  return info.type === 'root'
    ? fallbackUrl
    : `https://github.com/${info.owner}/${info.repo}/${info.type}/${info.ref}${info.path ? `/${info.path}` : ''}`
}

export async function resolveGitHubFetchInfo(
  info: GitHubUrlInfo,
  signal?: AbortSignal,
  resolver: typeof resolveGitHubUrlInfo = resolveGitHubUrlInfo,
) {
  if (!isResolvableRefPath(info)) return info
  return resolver(info, signal)
}

async function fetchGitHubContentWithInfo(
  info: GitHubUrlInfo,
  requestedUrl: string,
  signal?: AbortSignal,
  onUpdate?: (update: { content: Array<{ type: 'text'; text: string }> }) => void,
  refresh = false,
): Promise<GitHubFetchResult | null> {
  const finalUrl = buildCanonicalGitHubUrl(info, requestedUrl)
  let cloneInfo = info

  if (info.refIsFullSha) {
    onUpdate?.({
      content: [
        {
          type: 'text',
          text: '[github] Commit SHA URL detected, using GitHub API fallback...',
        },
      ],
    })

    const apiResult = await fetchGitHubContentViaApi(finalUrl, info, signal)
    if (apiResult) return apiResult

    onUpdate?.({
      content: [
        {
          type: 'text',
          text: '[github] API fallback unavailable, cloning default branch as best effort...',
        },
      ],
    })

    cloneInfo = {
      ...info,
      ref: undefined,
      refIsFullSha: false,
    }
  }

  let cloneError: unknown

  try {
    const clone = await ensureGitHubClone(cloneInfo, signal, refresh)
    onUpdate?.({
      content: [
        {
          type: 'text',
          text: renderGitHubCloneStatus(clone.localPath, clone.cacheStatus),
        },
      ],
    })

    let text = buildGitHubContentText(cloneInfo, clone.localPath, requestedUrl)
    if (info.refIsFullSha) {
      text = [
        '⚠️ Requested commit-SHA URL could not be fetched via GitHub API.',
        'Showing best-effort content from the default branch clone instead.',
        '',
        text,
      ].join('\n')
    }

    return {
      text,
      title: `${cloneInfo.owner}/${cloneInfo.repo}`,
      finalUrl,
      contentType: 'text/x-github-repository',
      githubType: cloneInfo.type,
      githubLocalPath: clone.localPath,
      githubSource: 'clone',
    }
  } catch (error) {
    cloneError = error
    onUpdate?.({
      content: [
        {
          type: 'text',
          text: '[github] Clone failed, trying GitHub API fallback...',
        },
      ],
    })
  }

  const apiFallback = await fetchGitHubContentViaApi(finalUrl, cloneInfo, signal)
  if (apiFallback) return apiFallback

  if (cloneError) throw cloneError
  return null
}

export async function fetchGitHubContent(
  url: string,
  signal?: AbortSignal,
  onUpdate?: (update: { content: Array<{ type: 'text'; text: string }> }) => void,
  refresh = false,
): Promise<GitHubFetchResult | null> {
  const info = parseGitHubUrl(url)
  if (!info) return null

  onUpdate?.({
    content: [{ type: 'text', text: `[github] Resolving ${info.owner}/${info.repo}...` }],
  })

  let resolvedInfo = info
  if (isResolvableRefPath(info)) {
    onUpdate?.({
      content: [
        {
          type: 'text',
          text: '[github] Resolving branch/tag metadata...',
        },
      ],
    })

    try {
      resolvedInfo = await resolveGitHubFetchInfo(info, signal)
    } catch {
      // Continue with the parsed info as a best effort when remote ref resolution fails.
    }
  }

  return fetchGitHubContentWithInfo(
    resolvedInfo,
    buildCanonicalGitHubUrl(resolvedInfo, url),
    signal,
    onUpdate,
    refresh,
  )
}

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

  let resolvedInfo: GitHubUrlInfo = info
  try {
    resolvedInfo = await resolveGitHubUrlInfo(info, signal)
  } catch {
    // Continue with best-effort parsed info.
  }

  const finalUrl =
    resolvedInfo.type === 'root'
      ? url
      : `https://github.com/${resolvedInfo.owner}/${resolvedInfo.repo}/${resolvedInfo.type}/${resolvedInfo.ref}${resolvedInfo.path ? `/${resolvedInfo.path}` : ''}`

  let cloneInfo = resolvedInfo

  if (resolvedInfo.refIsFullSha) {
    onUpdate?.({
      content: [
        {
          type: 'text',
          text: '[github] Commit SHA URL detected, using GitHub API fallback...',
        },
      ],
    })

    const apiResult = await fetchGitHubContentViaApi(finalUrl, resolvedInfo, signal)
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
      ...resolvedInfo,
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

    let text = buildGitHubContentText(cloneInfo, clone.localPath, url)
    if (resolvedInfo.refIsFullSha) {
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

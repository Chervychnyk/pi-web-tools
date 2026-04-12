export type GitHubUrlType = 'root' | 'blob' | 'tree'

export type GitHubCloneCacheStatus =
  | 'cached'
  | 'cloned'
  | 'manual-refresh'
  | 'stale-refresh'

export type GitHubCacheEntry = {
  ownerPath: string
  localPath: string
  lastUsedMs: number
}

export type GitHubUrlInfo = {
  owner: string
  repo: string
  ref?: string
  refIsFullSha: boolean
  path?: string
  type: GitHubUrlType
  refPathSegments?: string[]
}

export type GitHubFetchResult = {
  text: string
  title: string
  finalUrl: string
  contentType: string
  githubType: GitHubUrlType
  githubLocalPath?: string
  githubSource?: 'clone' | 'api'
}

export type EnsureGitHubCloneResult = {
  localPath: string
  cacheStatus: GitHubCloneCacheStatus
}

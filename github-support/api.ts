import type { GitHubFetchResult, GitHubUrlInfo } from './types.ts'
import {
  isProbablyBinaryPath,
  isProbablyBinaryBuffer,
} from './constants.ts'
import {
  formatGitHubInlineText,
  renderGitHubApiBlobText,
  renderGitHubApiRootText,
  renderGitHubApiTreeText,
} from './render.ts'

const GITHUB_API_BASE_URL = 'https://api.github.com'
const GITHUB_API_CONTENT_TYPE = 'text/x-github-repository-api'
const README_PREVIEW_CHARS = 8_192

type GitHubApiRepo = {
  default_branch?: string
}

type GitHubApiTreeEntry = {
  path?: string
  type?: 'blob' | 'tree'
}

type GitHubApiTree = {
  tree?: GitHubApiTreeEntry[]
}

type GitHubApiContentFile = {
  type?: 'file' | 'dir'
  name?: string
  path?: string
  size?: number
  content?: string
  encoding?: string
  download_url?: string | null
}

type GitHubApiContentDirectoryEntry = {
  type?: 'file' | 'dir' | 'symlink' | 'submodule'
  name?: string
  path?: string
  size?: number
}

function encodeRepoPath(repoPath: string) {
  return repoPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function getGitHubApiHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchGitHubApiJson<T>(
  endpoint: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    const response = await fetch(`${GITHUB_API_BASE_URL}${endpoint}`, {
      headers: getGitHubApiHeaders(),
      signal,
    })

    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

async function fetchGitHubApiText(url: string, signal?: AbortSignal) {
  try {
    const response = await fetch(url, {
      headers: getGitHubApiHeaders(),
      signal,
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

function decodeBase64(value: string) {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64')
}

function decodeContentFileText(contentFile: GitHubApiContentFile) {
  if (contentFile.encoding !== 'base64' || !contentFile.content) {
    return undefined
  }

  const buffer = decodeBase64(contentFile.content)
  if (
    isProbablyBinaryPath(contentFile.path || '') ||
    isProbablyBinaryBuffer(buffer)
  ) {
    return undefined
  }

  return buffer.toString('utf8')
}

async function resolveRef(info: GitHubUrlInfo, signal?: AbortSignal) {
  if (info.ref) return info.ref

  const repo = await fetchGitHubApiJson<GitHubApiRepo>(
    `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}`,
    signal,
  )

  return repo?.default_branch
}

function previewReadmeText(readmeText: string) {
  return readmeText.length > README_PREVIEW_CHARS
    ? `${readmeText.slice(0, README_PREVIEW_CHARS)}\n\n[README truncated at ${README_PREVIEW_CHARS} characters]`
    : readmeText
}

function formatDirectoryListing(entries: GitHubApiContentDirectoryEntry[]) {
  if (!entries.length) return ['(empty directory)']

  const sorted = [...entries].sort((left, right) =>
    (left.name || '').localeCompare(right.name || ''),
  )

  return sorted.map((entry) => {
    const name = entry.name || '(unknown)'
    if (entry.type === 'dir') return `- ${name}/`
    if (entry.type === 'file') return `- ${name} (${entry.size ?? 0} bytes)`
    return `- ${name} (${entry.type || 'unknown'})`
  })
}

async function fetchRootText(info: GitHubUrlInfo, ref: string, signal?: AbortSignal) {
  const [tree, readme] = await Promise.all([
    fetchGitHubApiJson<GitHubApiTree>(
      `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      signal,
    ),
    fetchGitHubApiJson<GitHubApiContentFile>(
      `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/readme?ref=${encodeURIComponent(ref)}`,
      signal,
    ),
  ])

  const treeEntries = (tree?.tree || [])
    .map((entry) => {
      const entryPath = entry.path || ''
      if (!entryPath) return ''
      return entry.type === 'tree' ? `${entryPath}/` : entryPath
    })
    .filter(Boolean)

  const readmeText = readme ? decodeContentFileText(readme) : undefined

  if (!treeEntries.length && !readmeText) return undefined

  return renderGitHubApiRootText(
    info,
    `https://github.com/${info.owner}/${info.repo}`,
    readmeText ? previewReadmeText(readmeText).trim() : undefined,
    treeEntries,
  )
}

async function fetchTreeText(
  info: GitHubUrlInfo,
  ref: string,
  signal?: AbortSignal,
) {
  const repoPath = info.path || ''
  const endpoint = repoPath
    ? `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents/${encodeRepoPath(repoPath)}?ref=${encodeURIComponent(ref)}`
    : `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents?ref=${encodeURIComponent(ref)}`

  const content = await fetchGitHubApiJson<
    GitHubApiContentFile | GitHubApiContentDirectoryEntry[]
  >(endpoint, signal)

  if (!content) return undefined

  if (Array.isArray(content)) {
    return renderGitHubApiTreeText(
      info,
      `https://github.com/${info.owner}/${info.repo}/tree/${ref}${repoPath ? `/${repoPath}` : ''}`,
      repoPath,
      formatDirectoryListing(content),
    )
  }

  if (content.type === 'dir') {
    return renderGitHubApiTreeText(
      info,
      `https://github.com/${info.owner}/${info.repo}/tree/${ref}${repoPath ? `/${repoPath}` : ''}`,
      repoPath,
      [`(directory listing unavailable for ${repoPath || '.'})`],
    )
  }

  return fetchBlobText(
    {
      ...info,
      type: 'blob',
      path: content.path || repoPath,
    },
    ref,
    signal,
  )
}

async function fetchBlobText(
  info: GitHubUrlInfo,
  ref: string,
  signal?: AbortSignal,
) {
  const repoPath = info.path || ''
  if (!repoPath) return undefined

  const endpoint = `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents/${encodeRepoPath(repoPath)}?ref=${encodeURIComponent(ref)}`
  const content = await fetchGitHubApiJson<GitHubApiContentFile>(endpoint, signal)

  if (!content) return undefined

  if (content.type === 'dir') {
    return fetchTreeText(
      {
        ...info,
        type: 'tree',
      },
      ref,
      signal,
    )
  }

  let inlineText = decodeContentFileText(content)

  if (inlineText === undefined && content.download_url) {
    inlineText = await fetchGitHubApiText(content.download_url, signal)
  }

  const body =
    inlineText === undefined
      ? `${
          isProbablyBinaryPath(repoPath)
            ? 'Binary file detected'
            : 'File content is not available as UTF-8 text'
        }${typeof content.size === 'number' ? ` (${content.size} bytes)` : ''}.`
      : formatGitHubInlineText(inlineText)

  return renderGitHubApiBlobText(
    info,
    `https://github.com/${info.owner}/${info.repo}/blob/${ref}/${repoPath}`,
    repoPath,
    body,
  )
}

export async function fetchGitHubContentViaApi(
  sourceUrl: string,
  info: GitHubUrlInfo,
  signal?: AbortSignal,
): Promise<GitHubFetchResult | null> {
  const ref = await resolveRef(info, signal)
  if (!ref) return null

  const resolvedInfo = {
    ...info,
    ref,
    refIsFullSha: /^[0-9a-f]{40}$/i.test(ref),
  }

  const text =
    resolvedInfo.type === 'root'
      ? await fetchRootText(resolvedInfo, ref, signal)
      : resolvedInfo.type === 'tree'
        ? await fetchTreeText(resolvedInfo, ref, signal)
        : await fetchBlobText(resolvedInfo, ref, signal)

  if (!text) return null

  return {
    text,
    title: `${resolvedInfo.owner}/${resolvedInfo.repo}`,
    finalUrl: sourceUrl,
    contentType: GITHUB_API_CONTENT_TYPE,
    githubType: resolvedInfo.type,
    githubSource: 'api',
  }
}

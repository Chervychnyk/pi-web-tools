import { normalizeHostname } from '../shared.ts'
import type { GitHubUrlInfo } from './types.ts'

const NON_CODE_SEGMENTS = new Set([
  'issues',
  'pull',
  'pulls',
  'discussions',
  'releases',
  'wiki',
  'actions',
  'settings',
  'security',
  'projects',
  'graphs',
  'compare',
  'commits',
  'tags',
  'branches',
  'stargazers',
  'watchers',
  'network',
  'forks',
  'milestone',
  'labels',
  'packages',
  'codespaces',
  'insights',
])

const SUPPORTED_GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'm.github.com',
])

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const host = normalizeHostname(parsed.hostname)
  if (!SUPPORTED_GITHUB_HOSTS.has(host)) return null

  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map(decodePathSegment)
  if (segments.length < 2) return null

  const owner = segments[0]!
  const repo = segments[1]!.replace(/\.git$/i, '')
  if (!owner || !repo) return null

  if (!segments[2]) {
    return { owner, repo, refIsFullSha: false, type: 'root' }
  }

  if (NON_CODE_SEGMENTS.has(segments[2]!.toLowerCase())) return null

  const type = segments[2]
  if (type !== 'blob' && type !== 'tree') return null
  if (segments.length < 4) return null

  const refPathSegments = segments.slice(3)
  const ref = refPathSegments[0]!
  const repoPath = refPathSegments.slice(1).join('/') || undefined

  return {
    owner,
    repo,
    ref,
    refIsFullSha: /^[0-9a-f]{40}$/i.test(ref),
    path: repoPath,
    type,
    refPathSegments,
  }
}

export function resolveGitHubRefPath(
  refPathSegments: string[],
  availableRefs: string[],
) {
  for (let length = refPathSegments.length - 1; length >= 1; length -= 1) {
    const candidateRef = refPathSegments.slice(0, length).join('/')
    if (!availableRefs.includes(candidateRef)) continue
    const repoPath = refPathSegments.slice(length).join('/') || undefined
    return { ref: candidateRef, path: repoPath }
  }

  return {
    ref: refPathSegments[0],
    path: refPathSegments.slice(1).join('/') || undefined,
  }
}

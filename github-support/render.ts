import {
  existsSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import type {
  GitHubCloneCacheStatus,
  GitHubUrlInfo,
} from './types.ts'
import {
  MAX_TREE_ENTRIES,
  MAX_INLINE_FILE_CHARS,
  isProbablyBinaryPath,
  isProbablyBinaryBuffer,
} from './constants.ts'

const README_CANDIDATES = [
  'README.md',
  'readme.md',
  'README',
  'readme',
  'README.txt',
]
const IGNORED_TREE_NAMES = new Set(['.git'])
const API_FALLBACK_SOURCE = 'GitHub API fallback (no local clone)'

type GitHubRenderContext = {
  info: GitHubUrlInfo
  url: string
  locationLabel?: string
  locationValue?: string
  sourceNote?: string
}

function appendLocation(lines: string[], context: GitHubRenderContext) {
  if (context.locationLabel && context.locationValue) {
    lines.push(`${context.locationLabel}: ${context.locationValue}`)
  }
  if (context.sourceNote) {
    lines.push(`Source: ${context.sourceNote}`)
  }
}

export function resolveWithinRepo(rootPath: string, relativePath = '') {
  const normalizedRoot = path.resolve(rootPath)
  const candidate = path.resolve(normalizedRoot, relativePath)
  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`

  if (candidate !== normalizedRoot && !candidate.startsWith(rootPrefix)) {
    return null
  }

  if (!existsSync(candidate)) return candidate

  try {
    const realRoot = realpathSync(normalizedRoot)
    const realCandidate = realpathSync(candidate)
    const realRootPrefix = realRoot.endsWith(path.sep)
      ? realRoot
      : `${realRoot}${path.sep}`
    if (realCandidate === realRoot) return candidate
    return realCandidate.startsWith(realRootPrefix) ? candidate : null
  } catch {
    return null
  }
}

function isProbablyBinaryFile(filePath: string) {
  if (isProbablyBinaryPath(filePath)) return true

  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(512)
    const bytesRead = readSync(fd, buffer, 0, 512, 0)
    return isProbablyBinaryBuffer(buffer, bytesRead)
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readUtf8(filePath: string) {
  return readFileSync(filePath, 'utf8')
}

function findReadme(rootPath: string) {
  for (const candidate of README_CANDIDATES) {
    const filePath = resolveWithinRepo(rootPath, candidate)
    if (filePath && existsSync(filePath)) return filePath
  }
  return undefined
}

function collectTreeEntries(rootPath: string, relativePath = '') {
  const startPath = resolveWithinRepo(rootPath, relativePath)
  if (!startPath || !existsSync(startPath)) {
    throw new Error(`Path not found in repository: ${relativePath || '.'}`)
  }

  const entries: string[] = []

  function walk(currentPath: string, currentRelative: string, depth: number) {
    if (entries.length >= MAX_TREE_ENTRIES) return

    const children = readdirSync(currentPath).sort((left, right) =>
      left.localeCompare(right),
    )

    for (const child of children) {
      if (entries.length >= MAX_TREE_ENTRIES) return
      if (IGNORED_TREE_NAMES.has(child)) continue

      const rel = currentRelative ? `${currentRelative}/${child}` : child
      const safePath = resolveWithinRepo(rootPath, rel)
      if (!safePath || !existsSync(safePath)) continue

      const stats = statSync(safePath)
      const indent = '  '.repeat(depth)
      if (stats.isDirectory()) {
        entries.push(`${indent}- ${child}/`)
        if (depth < 3) walk(safePath, rel, depth + 1)
      } else {
        entries.push(`${indent}- ${child}`)
      }
    }
  }

  const stats = statSync(startPath)
  if (!stats.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${relativePath}`)
  }

  walk(startPath, relativePath, 0)
  return entries
}

export function formatGitHubTreeEntries(entries: string[]) {
  if (!entries.length) return '(empty directory)'
  const visibleEntries = entries.slice(0, MAX_TREE_ENTRIES)
  if (entries.length <= MAX_TREE_ENTRIES) return visibleEntries.join('\n')
  return `${visibleEntries.join('\n')}\n... truncated after ${MAX_TREE_ENTRIES} entries`
}

export function formatGitHubInlineText(text: string) {
  return text.length > MAX_INLINE_FILE_CHARS
    ? `${text.slice(0, MAX_INLINE_FILE_CHARS)}\n\n---\n[File truncated: showing first ${MAX_INLINE_FILE_CHARS} of ${text.length} characters]`
    : text
}

export function renderGitHubRootText(
  context: GitHubRenderContext & {
    readmeText?: string
    treeText: string
  },
) {
  const lines = [
    `# ${context.info.owner}/${context.info.repo}`,
    '',
    `GitHub repository: ${context.url}`,
  ]

  appendLocation(lines, context)

  if (context.readmeText) {
    lines.push('', '## README', '', context.readmeText.trim())
  }

  lines.push('', '## Tree', '', context.treeText)
  return lines.join('\n')
}

export function renderGitHubTreeText(
  context: GitHubRenderContext & {
    repoPath: string
    treeText: string
  },
) {
  const lines = [
    `# ${context.info.owner}/${context.info.repo}`,
    '',
    `GitHub directory: ${context.url}`,
  ]

  appendLocation(lines, context)
  lines.push('', `## ${context.repoPath || '.'}`, '', context.treeText)
  return lines.join('\n')
}

export function renderGitHubBlobText(
  context: GitHubRenderContext & {
    repoPath: string
    body: string
  },
) {
  const lines = [
    `# ${context.info.owner}/${context.info.repo}`,
    '',
    `GitHub file: ${context.url}`,
  ]

  appendLocation(lines, context)
  lines.push('', `## ${context.repoPath}`, '', context.body)
  return lines.join('\n')
}

export function buildGitHubContentText(
  info: GitHubUrlInfo,
  localPath: string,
  url: string,
) {
  if (info.type === 'root') {
    const readmePath = findReadme(localPath)
    return renderGitHubRootText({
      info,
      url,
      locationLabel: 'Local path',
      locationValue: localPath,
      readmeText: readmePath ? readUtf8(readmePath) : undefined,
      treeText: formatGitHubTreeEntries(collectTreeEntries(localPath)),
    })
  }

  const repoPath = info.path || ''
  const resolved = resolveWithinRepo(localPath, repoPath)
  if (!resolved || !existsSync(resolved)) {
    throw new Error(
      `Repository ${info.type === 'tree' ? 'path' : 'file'} not found: ${repoPath}`,
    )
  }

  if (info.type === 'tree') {
    return renderGitHubTreeText({
      info,
      url,
      locationLabel: 'Local path',
      locationValue: resolved,
      repoPath,
      treeText: formatGitHubTreeEntries(collectTreeEntries(localPath, repoPath)),
    })
  }

  const stats = statSync(resolved)
  if (!stats.isFile()) {
    throw new Error(`Repository path is not a file: ${repoPath}`)
  }

  const body = isProbablyBinaryFile(resolved)
    ? [
        `Binary file detected: ${repoPath}`,
        `Size: ${stats.size} bytes`,
      ].join('\n')
    : formatGitHubInlineText(readUtf8(resolved))

  return renderGitHubBlobText({
    info,
    url,
    locationLabel: 'Local path',
    locationValue: resolved,
    repoPath,
    body,
  })
}

export function renderGitHubApiRootText(
  info: GitHubUrlInfo,
  url: string,
  readmeText: string | undefined,
  treeEntries: string[],
) {
  return renderGitHubRootText({
    info,
    url,
    sourceNote: API_FALLBACK_SOURCE,
    readmeText,
    treeText: formatGitHubTreeEntries(treeEntries),
  })
}

export function renderGitHubApiTreeText(
  info: GitHubUrlInfo,
  url: string,
  repoPath: string,
  treeEntries: string[],
) {
  return renderGitHubTreeText({
    info,
    url,
    sourceNote: API_FALLBACK_SOURCE,
    repoPath,
    treeText: formatGitHubTreeEntries(treeEntries),
  })
}

export function renderGitHubApiBlobText(
  info: GitHubUrlInfo,
  url: string,
  repoPath: string,
  body: string,
) {
  return renderGitHubBlobText({
    info,
    url,
    sourceNote: API_FALLBACK_SOURCE,
    repoPath,
    body,
  })
}

export function renderGitHubCloneStatus(
  localPath: string,
  cacheStatus: GitHubCloneCacheStatus,
) {
  switch (cacheStatus) {
    case 'cached':
      return `[github] Using cached local clone at ${localPath}`
    case 'manual-refresh':
      return `[github] Refreshed local clone at ${localPath}`
    case 'stale-refresh':
      return `[github] Refreshed stale local clone at ${localPath}`
    default:
      return `[github] Cloned repository to ${localPath}`
  }
}

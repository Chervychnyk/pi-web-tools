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

function buildTree(rootPath: string, relativePath = '') {
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

  if (!entries.length) return '(empty directory)'
  if (entries.length >= MAX_TREE_ENTRIES) {
    entries.push(`... truncated after ${MAX_TREE_ENTRIES} entries`)
  }
  return entries.join('\n')
}

function buildRootText(info: GitHubUrlInfo, localPath: string, url: string) {
  const lines = [
    `# ${info.owner}/${info.repo}`,
    '',
    `GitHub repository: ${url}`,
    `Local path: ${localPath}`,
  ]

  const readmePath = findReadme(localPath)
  if (readmePath) {
    lines.push('', '## README', '', readUtf8(readmePath).trim())
  }

  lines.push('', '## Tree', '', buildTree(localPath))
  return lines.join('\n')
}

function buildTreeText(info: GitHubUrlInfo, localPath: string, url: string) {
  const repoPath = info.path || ''
  const resolved = resolveWithinRepo(localPath, repoPath)
  if (!resolved || !existsSync(resolved)) {
    throw new Error(`Repository path not found: ${repoPath}`)
  }

  return [
    `# ${info.owner}/${info.repo}`,
    '',
    `GitHub directory: ${url}`,
    `Local path: ${resolved}`,
    '',
    `## ${repoPath || '.'}`,
    '',
    buildTree(localPath, repoPath),
  ].join('\n')
}

function buildBlobText(info: GitHubUrlInfo, localPath: string, url: string) {
  const repoPath = info.path || ''
  const resolved = resolveWithinRepo(localPath, repoPath)
  if (!resolved || !existsSync(resolved)) {
    throw new Error(`Repository file not found: ${repoPath}`)
  }

  const stats = statSync(resolved)
  if (!stats.isFile()) {
    throw new Error(`Repository path is not a file: ${repoPath}`)
  }

  if (isProbablyBinaryFile(resolved)) {
    return [
      `# ${info.owner}/${info.repo}`,
      '',
      `GitHub file: ${url}`,
      `Local path: ${resolved}`,
      '',
      `Binary file detected: ${repoPath}`,
      `Size: ${stats.size} bytes`,
    ].join('\n')
  }

  const text = readUtf8(resolved)
  const inlineText =
    text.length > MAX_INLINE_FILE_CHARS
      ? `${text.slice(0, MAX_INLINE_FILE_CHARS)}\n\n---\n[File truncated: showing first ${MAX_INLINE_FILE_CHARS} of ${text.length} characters]`
      : text

  return [
    `# ${info.owner}/${info.repo}`,
    '',
    `GitHub file: ${url}`,
    `Local path: ${resolved}`,
    '',
    `## ${repoPath}`,
    '',
    inlineText,
  ].join('\n')
}

export function buildGitHubContentText(
  info: GitHubUrlInfo,
  localPath: string,
  url: string,
) {
  return info.type === 'root'
    ? buildRootText(info, localPath, url)
    : info.type === 'tree'
      ? buildTreeText(info, localPath, url)
      : buildBlobText(info, localPath, url)
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

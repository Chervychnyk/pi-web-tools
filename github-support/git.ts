import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileAsync } from '../shared.ts'
import type { GitHubUrlInfo } from './types.ts'
import { resolveGitHubRefPath } from './url.ts'

let ghCliAvailable: boolean | undefined

export function getEmptyGitTemplateDir() {
  const templateDir = path.join(tmpdir(), 'pi-web-tools-empty-git-template')
  mkdirSync(templateDir, { recursive: true })
  return templateDir
}

async function hasGhCli(signal?: AbortSignal) {
  if (ghCliAvailable !== undefined) return ghCliAvailable

  try {
    await execFileAsync('gh', ['--version'], signal)
    ghCliAvailable = true
  } catch {
    ghCliAvailable = false
  }

  return ghCliAvailable
}

async function listGitRemoteRefsWithGh(
  owner: string,
  repo: string,
  signal?: AbortSignal,
) {
  const readRefs = async (namespace: 'heads' | 'tags') => {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        `repos/${owner}/${repo}/git/matching-refs/${namespace}`,
        '--paginate',
        '--slurp',
      ],
      signal,
    )

    const pages = JSON.parse(stdout) as Array<Array<{ ref?: string }>>
    return pages
      .flatMap((page) => page)
      .map((item) => item.ref || '')
      .filter(Boolean)
  }

  const refs = [...(await readRefs('heads')), ...(await readRefs('tags'))]

  return refs
    .filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))
    .map((ref) => ref.replace(/^refs\/(heads|tags)\//, ''))
}

export async function cloneGitHubRepo(
  info: GitHubUrlInfo,
  localPath: string,
  signal?: AbortSignal,
) {
  if (await hasGhCli(signal)) {
    try {
      const ghArgs = ['repo', 'clone', `${info.owner}/${info.repo}`, localPath, '--']
      if (info.ref) ghArgs.push('--branch', info.ref)
      ghArgs.push('--depth', '1', '--single-branch', '--template', getEmptyGitTemplateDir())
      await execFileAsync('gh', ghArgs, signal)
      return
    } catch {
      // Fall back to plain git below.
    }
  }

  const gitArgs = [
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--template',
    getEmptyGitTemplateDir(),
  ]
  if (info.ref) gitArgs.push('--branch', info.ref)
  gitArgs.push(`https://github.com/${info.owner}/${info.repo}.git`, localPath)

  await execFileAsync('git', gitArgs, signal)
}

async function listGitRemoteRefs(
  owner: string,
  repo: string,
  signal?: AbortSignal,
) {
  if (await hasGhCli(signal)) {
    try {
      const refs = await listGitRemoteRefsWithGh(owner, repo, signal)
      if (refs.length) return refs
    } catch {
      // Fall back to plain git below.
    }
  }

  const { stdout } = await execFileAsync(
    'git',
    ['ls-remote', '--heads', '--tags', `https://github.com/${owner}/${repo}.git`],
    signal,
  )

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] || '')
    .filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))
    .map((ref) => ref.replace(/^refs\/(heads|tags)\//, ''))
}

export async function resolveGitHubUrlInfo(
  info: GitHubUrlInfo,
  signal?: AbortSignal,
): Promise<GitHubUrlInfo> {
  if (
    info.type === 'root' ||
    !info.refPathSegments ||
    info.refPathSegments.length <= 1
  ) {
    return info
  }

  const availableRefs = await listGitRemoteRefs(info.owner, info.repo, signal)
  const resolved = resolveGitHubRefPath(info.refPathSegments, availableRefs)
  return {
    ...info,
    ref: resolved.ref,
    refIsFullSha: /^[0-9a-f]{40}$/i.test(resolved.ref || ''),
    path: resolved.path,
  }
}

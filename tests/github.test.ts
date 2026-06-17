import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { MAX_TREE_ENTRIES } from '../github-support/constants.ts'
import { formatGitHubTreeEntries } from '../github-support/render.ts'
import {
  isGitHubCacheStale,
  parseGitHubUrl,
  pruneGitHubCacheDir,
  resolveGitHubFetchInfo,
  resolveGitHubRefPath,
  resolveWithinRepo,
} from '../github.ts'

describe('parseGitHubUrl', () => {
  it('parses repo root URLs', () => {
    assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo'), {
      owner: 'owner',
      repo: 'repo',
      refIsFullSha: false,
      type: 'root',
    })
  })

  it('parses mobile-host variant', () => {
    assert.deepEqual(parseGitHubUrl('https://m.github.com/owner/repo'), {
      owner: 'owner',
      repo: 'repo',
      refIsFullSha: false,
      type: 'root',
    })
  })

  it('parses trailing-dot host', () => {
    assert.deepEqual(parseGitHubUrl('https://github.com./owner/repo'), {
      owner: 'owner',
      repo: 'repo',
      refIsFullSha: false,
      type: 'root',
    })
  })

  it('parses blob URLs with a ref + path', () => {
    assert.deepEqual(
      parseGitHubUrl('https://github.com/owner/repo/blob/main/src/index.ts'),
      {
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        refIsFullSha: false,
        path: 'src/index.ts',
        type: 'blob',
        refPathSegments: ['main', 'src', 'index.ts'],
      },
    )
  })

  it('returns null for non-repo paths like /issues/N', () => {
    assert.equal(parseGitHubUrl('https://github.com/owner/repo/issues/123'), null)
  })
})

describe('resolveGitHubRefPath', () => {
  it('matches the longest available ref against the segment prefix', () => {
    assert.deepEqual(
      resolveGitHubRefPath(['feature', 'foo', 'src', 'index.ts'], [
        'main',
        'feature/foo',
      ]),
      { ref: 'feature/foo', path: 'src/index.ts' },
    )
  })
})

describe('resolveWithinRepo', () => {
  it('refuses paths that escape the repo or pass through symlinks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-gh-'))
    try {
      mkdirSync(path.join(root, 'src'))
      writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n')
      symlinkSync('/tmp', path.join(root, 'src', 'tmp-link'))

      assert.equal(
        resolveWithinRepo(root, 'src/index.ts'),
        path.join(root, 'src', 'index.ts'),
      )
      assert.equal(resolveWithinRepo(root, '../outside.txt'), null)
      assert.equal(resolveWithinRepo(root, 'src/tmp-link'), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resolveGitHubFetchInfo', () => {
  it('runs the resolver exactly once and propagates ref/path', async () => {
    const info = parseGitHubUrl('https://github.com/owner/repo/blob/release/v1/README.md')
    assert.ok(info)

    let resolverCalls = 0
    const resolved = await resolveGitHubFetchInfo(info!, undefined, async () => {
      resolverCalls += 1
      return { ...info!, ref: 'release/v1', path: 'README.md', refIsFullSha: false }
    })

    assert.equal(resolverCalls, 1)
    assert.equal(resolved.ref, 'release/v1')
    assert.equal(resolved.path, 'README.md')
  })
})

describe('formatGitHubTreeEntries', () => {
  it(`truncates above ${MAX_TREE_ENTRIES} entries and notes the cut`, () => {
    const entries = Array.from(
      { length: MAX_TREE_ENTRIES + 5 },
      (_, index) => `- file-${index + 1}`,
    )
    const lines = formatGitHubTreeEntries(entries).split('\n')

    assert.equal(lines.length, MAX_TREE_ENTRIES + 1)
    assert.equal(lines[0], '- file-1')
    assert.equal(lines[MAX_TREE_ENTRIES - 1], `- file-${MAX_TREE_ENTRIES}`)
    assert.equal(lines[MAX_TREE_ENTRIES], `... truncated after ${MAX_TREE_ENTRIES} entries`)
  })
})

describe('isGitHubCacheStale', () => {
  it('returns true when the cache is older than the max age', () => {
    assert.equal(isGitHubCacheStale(0, 10_000, 5_000), true)
    assert.equal(isGitHubCacheStale(6_000, 10_000, 5_000), false)
  })
})

describe('pruneGitHubCacheDir', () => {
  it('keeps the N most recently touched repos and evicts the rest', () => {
    const overflowRoot = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-gh-overflow-'))
    try {
      const newest = path.join(overflowRoot, 'owner-a', 'repo-newest')
      const recent = path.join(overflowRoot, 'owner-a', 'repo-recent')
      const overflow = path.join(overflowRoot, 'owner-b', 'repo-overflow')

      for (const repoPath of [newest, recent, overflow]) {
        mkdirSync(path.join(repoPath, '.git'), { recursive: true })
        const relativeRepoPath = path.relative(overflowRoot, repoPath)
        const metadataPath = path.join(
          overflowRoot,
          '.meta',
          relativeRepoPath,
          '.pi-web-tools-cache-touch',
        )
        mkdirSync(path.dirname(metadataPath), { recursive: true })
        writeFileSync(metadataPath, 'touch\n')
      }

      utimesSync(
        path.join(overflowRoot, '.meta', 'owner-a', 'repo-newest', '.pi-web-tools-cache-touch'),
        new Date(4_000),
        new Date(4_000),
      )
      utimesSync(
        path.join(overflowRoot, '.meta', 'owner-a', 'repo-recent', '.pi-web-tools-cache-touch'),
        new Date(3_000),
        new Date(3_000),
      )
      utimesSync(
        path.join(overflowRoot, '.meta', 'owner-b', 'repo-overflow', '.pi-web-tools-cache-touch'),
        new Date(2_000),
        new Date(2_000),
      )

      pruneGitHubCacheDir(overflowRoot, {
        maxRepos: 2,
        maxAgeMs: Number.MAX_SAFE_INTEGER,
        now: 5_000,
      })

      assert.equal(existsSync(newest), true)
      assert.equal(existsSync(recent), true)
      assert.equal(existsSync(overflow), false)
    } finally {
      rmSync(overflowRoot, { recursive: true, force: true })
    }
  })

  it('evicts repos older than maxAgeMs even when under the count cap', () => {
    const expiryRoot = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-gh-expiry-'))
    try {
      const staleRepo = path.join(expiryRoot, 'owner-c', 'repo-stale')
      mkdirSync(path.join(staleRepo, '.git'), { recursive: true })
      const staleMetadataPath = path.join(
        expiryRoot,
        '.meta',
        'owner-c',
        'repo-stale',
        '.pi-web-tools-cache-touch',
      )
      mkdirSync(path.dirname(staleMetadataPath), { recursive: true })
      writeFileSync(staleMetadataPath, 'touch\n')
      utimesSync(
        path.join(expiryRoot, '.meta', 'owner-c', 'repo-stale', '.pi-web-tools-cache-touch'),
        new Date(1_000),
        new Date(1_000),
      )

      pruneGitHubCacheDir(expiryRoot, {
        maxRepos: 10,
        maxAgeMs: 1_000,
        now: 5_000,
      })

      assert.equal(existsSync(staleRepo), false)
    } finally {
      rmSync(expiryRoot, { recursive: true, force: true })
    }
  })
})

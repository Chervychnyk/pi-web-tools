import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runFetchTests } from './tests/fetch.ts'
import { runGitHubTests } from './tests/github.ts'
import { runSearchTests } from './tests/search.ts'
import { runSharedTests } from './tests/shared.ts'
import { runStorageTests } from './tests/storage.ts'

const previousStorageDir = process.env.PI_WEB_TOOLS_STORAGE_DIR
const previousGitHubDir = process.env.PI_WEB_TOOLS_GITHUB_DIR
const suiteCacheRoot = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-suite-'))
process.env.PI_WEB_TOOLS_STORAGE_DIR = path.join(suiteCacheRoot, 'storage')
process.env.PI_WEB_TOOLS_GITHUB_DIR = path.join(suiteCacheRoot, 'github')

try {
  await runFetchTests()
  await runSearchTests()
  await runStorageTests()
  await runGitHubTests()
  await runSharedTests()
  console.log('tests ok')
} finally {
  if (previousStorageDir === undefined) {
    delete process.env.PI_WEB_TOOLS_STORAGE_DIR
  } else {
    process.env.PI_WEB_TOOLS_STORAGE_DIR = previousStorageDir
  }

  if (previousGitHubDir === undefined) {
    delete process.env.PI_WEB_TOOLS_GITHUB_DIR
  } else {
    process.env.PI_WEB_TOOLS_GITHUB_DIR = previousGitHubDir
  }

  rmSync(suiteCacheRoot, { recursive: true, force: true })
}

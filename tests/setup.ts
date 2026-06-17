// Imported via `node --test --import ./tests/setup.ts` so it runs before any
// test file's imports. Redirects storage + GitHub cache into a temp dir so
// tests never touch the real ~/.pi/cache/web-tools directory.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const suiteCacheRoot = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-suite-'))
process.env.PI_WEB_TOOLS_STORAGE_DIR = path.join(suiteCacheRoot, 'storage')
process.env.PI_WEB_TOOLS_GITHUB_DIR = path.join(suiteCacheRoot, 'github')

process.on('exit', () => {
  rmSync(suiteCacheRoot, { recursive: true, force: true })
})

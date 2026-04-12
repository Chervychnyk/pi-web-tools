import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { cleanupGitHubCache } from './github-support/cache.ts'
import { registerGetWebContentTool } from './get-web-content.ts'
import { registerWebFetchTool } from './web-fetch.ts'
import { registerWebSearchTool } from './web-search.ts'

export default function webToolsExtension(pi: ExtensionAPI) {
  registerWebSearchTool(pi)
  registerWebFetchTool(pi)
  registerGetWebContentTool(pi)

  pi.on('session_shutdown', () => {
    cleanupGitHubCache()
  })
}

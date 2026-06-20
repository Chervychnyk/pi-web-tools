import { fetchGitHubContent, parseGitHubUrl } from '../../github.ts'
import { buildTextFetchResult } from '../result.ts'
import type { FetchOutputFormat } from '../types.ts'
import type { UrlHandler } from '../url-handler.ts'

function canUseTextLikeFetchFormat(format: FetchOutputFormat | undefined) {
  return format === undefined || format === 'markdown' || format === 'text'
}

export function createGitHubHandler(
  githubFetcher: typeof fetchGitHubContent = fetchGitHubContent,
): UrlHandler {
  return {
    name: 'github',
    match(url) {
      return parseGitHubUrl(url.toString()) !== null
    },
    validate(parsed) {
      if (parsed.selector) {
        throw new Error('Selector is not supported for GitHub repository URLs')
      }
      if (!canUseTextLikeFetchFormat(parsed.requestedFormat)) {
        throw new Error(
          `GitHub repository URLs only support markdown or text output, received: ${parsed.requestedFormat}`,
        )
      }
    },
    async fetch(ctx) {
      const { url, parsed, signal, progress, cacheKey } = ctx
      const githubContent = await githubFetcher(
        url.toString(),
        signal,
        progress.onUpdate,
        parsed.refresh,
      )
      if (!githubContent) return null

      const format = parsed.requestedFormat ?? 'markdown'
      return buildTextFetchResult(
        githubContent.text,
        '.md',
        parsed.maxChars,
        cacheKey,
        parsed.url,
        {
          url: githubContent.finalUrl,
          format,
          githubType: githubContent.githubType,
          githubSource: githubContent.githubSource,
          githubLocalPath: githubContent.githubLocalPath,
          title: githubContent.title,
          contentType: githubContent.contentType,
          cached: false,
          cacheAgeMs: 0,
        },
      )
    },
  }
}

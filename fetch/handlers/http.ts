import { extractPdfText, fetchViaJinaReader } from '../network.ts'
import { fetchWithOptionalCloudflareRetry } from '../guarded-http-client.ts'
import {
  cleanupDownloadedFile,
  processFetchResponse,
} from '../response-processor.ts'
import type { FetchResult, UrlHandler } from '../url-handler.ts'

export type DefaultHttpHandlerDependencies = {
  networkFetcher?: typeof fetchWithOptionalCloudflareRetry
  jinaFetcher?: typeof fetchViaJinaReader
  pdfTextExtractor?: typeof extractPdfText
}

export function createDefaultHttpHandler(
  deps: DefaultHttpHandlerDependencies = {},
): UrlHandler {
  const networkFetcher = deps.networkFetcher || fetchWithOptionalCloudflareRetry
  const jinaFetcher = deps.jinaFetcher || fetchViaJinaReader
  const pdfTextExtractor = deps.pdfTextExtractor || extractPdfText

  return {
    name: 'http',
    match() {
      return true
    },
    validate() {
      // Response-shape validation happens after classification.
      // Selector/format combinations that are statically incompatible are deferred to runtime
      // because we don't know the response MIME type yet.
    },
    async fetch(ctx): Promise<FetchResult> {
      const { url, parsed, signal, progress, cacheKey } = ctx
      let downloadedFilePathForCleanup: string | undefined

      try {
        progress.emit('network', `GET ${url.hostname}`)

        const { response, cloudflareBypassed } = await networkFetcher(
          url,
          signal,
          progress.onUpdate,
          undefined,
          {
            headers: parsed.headers,
            proxy: parsed.proxy,
          },
        )
        downloadedFilePathForCleanup = response.downloadedFilePath

        return await processFetchResponse({
          response,
          cloudflareBypassed,
          url,
          parsed,
          signal,
          progress,
          cacheKey,
          dispatch: ctx.dispatch,
          jinaFetcher,
          pdfTextExtractor,
          releaseDownloadedFile() {
            downloadedFilePathForCleanup = undefined
          },
        })
      } catch (error) {
        cleanupDownloadedFile(downloadedFilePathForCleanup)
        downloadedFilePathForCleanup = undefined
        throw error
      } finally {
        cleanupDownloadedFile(downloadedFilePathForCleanup)
      }
    },
  }
}

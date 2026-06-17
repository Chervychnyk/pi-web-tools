import { normalizeWhitespace } from '../shared.ts'
import {
  cleanupMarkdown,
  extractBestHtmlContent,
  extractHtmlTitle,
  getTurndownService,
  isPoorMarkdownConversion,
  selectFragment,
} from './content.ts'
import { emitFetchProgress } from './progress.ts'
import {
  decodeBodyAsText,
  extractPdfText,
  fetchViaJinaReader,
  looksLikeBlockedOrJunkContent,
} from './network.ts'
import type {
  ExtractedFetchContent,
  FetchOutputFormat,
  FetchProgressHandler,
  FetchRequestOptions,
  FetchResponseClassification,
} from './types.ts'

export type FetchExtractorDependencies = {
  jinaFetcher: typeof fetchViaJinaReader
  pdfTextExtractor: typeof extractPdfText
}

export async function extractFetchContent(
  options: {
    bodyBuffer: Buffer
    classification: FetchResponseClassification
    selector?: string
    signal: AbortSignal
    onUpdate?: FetchProgressHandler
    requestOptions?: Pick<FetchRequestOptions, 'proxy'>
  } & FetchExtractorDependencies,
): Promise<ExtractedFetchContent> {
  const {
    bodyBuffer,
    classification,
    selector,
    signal,
    onUpdate,
    jinaFetcher,
    pdfTextExtractor,
    requestOptions,
  } = options

  const raw = decodeBodyAsText(bodyBuffer, classification.contentType)
  const format = classification.format as FetchOutputFormat
  let article: ExtractedFetchContent['article']
  let content = raw
  let jinaFallbackUsed = false
  let pdfExtracted = false

  emitFetchProgress(onUpdate, 'process', format)

  if (format === 'json') {
    try {
      content = JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      throw new Error(`Failed to parse response as JSON: ${classification.finalUrl}`)
    }
  } else if (format === 'html') {
    if (selector) {
      const selection = selectFragment(raw, selector)
      article = {
        title: extractHtmlTitle(raw),
        byline: null,
        excerpt: null,
        siteName: null,
        contentHtml: selection.html,
        textContent: selection.text,
        extractionMethod: 'selector',
        selectedSelector: selector,
      }
      content = selection.html
    }
  } else if (format === 'text' || format === 'markdown') {
    if (classification.isPdf) {
      emitFetchProgress(onUpdate, 'extract', 'pdf text')
      content = normalizeWhitespace(
        await pdfTextExtractor(bodyBuffer, signal),
      )
      pdfExtracted = true
    } else if (classification.isHtml) {
      emitFetchProgress(
        onUpdate,
        'extract',
        selector
          ? `selector ${selector}`
          : format === 'markdown'
            ? 'readability'
            : 'main text',
      )
      article = extractBestHtmlContent(raw, classification.finalUrl, selector)

      if (format === 'markdown') {
        emitFetchProgress(onUpdate, 'convert', 'html → markdown')
        content = cleanupMarkdown(
          getTurndownService().turndown(article.contentHtml),
        )
        if (isPoorMarkdownConversion(content)) {
          content = article.textContent
        }
      } else {
        content = article.textContent
      }

      if (!selector && looksLikeBlockedOrJunkContent(content)) {
        const jina = await jinaFetcher(
          new URL(classification.finalUrl),
          signal,
          onUpdate,
          undefined,
          requestOptions,
        )
        content = jina.content
        article = undefined
        jinaFallbackUsed = true
      }
    } else if (classification.isText || classification.isJson) {
      content = format === 'text' ? normalizeWhitespace(raw) : raw.trim()
    } else {
      throw new Error(
        `Unsupported content type for ${format} output: ${classification.contentType || 'unknown'}`,
      )
    }
  } else {
    throw new Error(`Unsupported format: ${format}`)
  }

  return {
    content,
    article,
    jinaFallbackUsed,
    pdfExtracted,
  }
}

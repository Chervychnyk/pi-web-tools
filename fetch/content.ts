import { Readability } from '@mozilla/readability'
import * as cheerio from 'cheerio'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { normalizeWhitespace } from '../shared.ts'
import type { ArticleData } from './types.ts'

const CONTENT_SELECTOR_CANDIDATES = [
  'article',
  'main',
  '[role="main"]',
  '#content',
  '.content',
  '.post-content',
  '.entry-content',
  '.article',
  '.markdown-body',
]
const SELECTOR_FALLBACK_MIN_TEXT_LENGTH = 280

type SelectorFragment = { html: string; text: string; selector: string }

function selectFragmentWith$($: cheerio.CheerioAPI, selector: string): SelectorFragment {
  const selected = $(selector)

  if (!selected.length) {
    throw new Error(`No elements found for selector: ${selector}`)
  }

  const outerHtml = selected
    .map((_, element) => $.html(element))
    .get()
    .join('\n')

  const text = normalizeWhitespace(selected.text())

  return { html: outerHtml, text, selector }
}

export function selectFragment(html: string, selector: string): SelectorFragment {
  return selectFragmentWith$(cheerio.load(html), selector)
}

function findBestContentSelector(html: string): SelectorFragment | null {
  const $ = cheerio.load(html)
  let best: SelectorFragment | null = null

  for (const selector of CONTENT_SELECTOR_CANDIDATES) {
    try {
      const current = selectFragmentWith$($, selector)
      if (!current.text) continue
      if (!best || current.text.length > best.text.length) {
        best = current
      }
    } catch {
      // selector didn't match
    }
  }

  return best
}

export function extractHtmlTitle(html: string) {
  try {
    return new JSDOM(html).window.document.title?.trim() || null
  } catch {
    return null
  }
}

function extractReadableArticle(html: string, url: string): ArticleData {
  const dom = new JSDOM(html, { url })
  const article = new Readability(dom.window.document).parse()
  const fallbackHtml = dom.window.document.body?.innerHTML || ''
  const fallbackText = normalizeWhitespace(
    dom.window.document.body?.textContent || '',
  )

  return {
    title: article?.title?.trim() || dom.window.document.title?.trim() || null,
    byline: article?.byline?.trim() || null,
    excerpt: article?.excerpt?.trim() || null,
    siteName: article?.siteName?.trim() || null,
    contentHtml: article?.content || fallbackHtml,
    textContent: normalizeWhitespace(article?.textContent || fallbackText),
    extractionMethod: article ? 'readability' : 'document',
  }
}

export function extractBestHtmlContent(
  html: string,
  url: string,
  selector?: string,
): ArticleData {
  if (selector) {
    const selected = selectFragment(html, selector)
    return {
      title: extractHtmlTitle(html),
      byline: null,
      excerpt: null,
      siteName: null,
      contentHtml: selected.html,
      textContent: selected.text,
      extractionMethod: 'selector',
      selectedSelector: selector,
    }
  }

  const article = extractReadableArticle(html, url)
  if (article.textContent.length >= SELECTOR_FALLBACK_MIN_TEXT_LENGTH) {
    return article
  }

  const bestSelector = findBestContentSelector(html)
  if (!bestSelector || bestSelector.text.length <= article.textContent.length) {
    return article
  }

  return {
    title: article.title || extractHtmlTitle(html),
    byline: article.byline,
    excerpt: article.excerpt,
    siteName: article.siteName,
    contentHtml: bestSelector.html,
    textContent: bestSelector.text,
    extractionMethod: 'fallback-selector',
    selectedSelector: bestSelector.selector,
  }
}

let turndownInstance: TurndownService | undefined

export function getTurndownService() {
  if (!turndownInstance) {
    turndownInstance = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
    })
    turndownInstance.use(gfm)
    turndownInstance.addRule('removeEmptyLinks', {
      filter: (node) => node.nodeName === 'A' && !node.textContent?.trim(),
      replacement: () => '',
    })
  }
  return turndownInstance
}

export function cleanupMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const cleaned: string[] = []
  let inFence = false

  for (const rawLine of lines) {
    let line = rawLine.replace(/[ \t]+$/g, '')

    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      cleaned.push(line)
      continue
    }

    if (inFence) {
      cleaned.push(line)
      continue
    }

    line = line.replace(/\[\s*\]\([^)]*\)/g, '')
    line = line.replace(/ {2,}/g, ' ')
    line = line.replace(/\s+([,.;:!?])/g, '$1')

    if (line.trim() === '') {
      if (cleaned[cleaned.length - 1] !== '') cleaned.push('')
      continue
    }

    cleaned.push(line)
  }

  return cleaned
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extensionForFormat(format: string): string {
  switch (format) {
    case 'markdown':
      return '.md'
    case 'html':
      return '.html'
    case 'json':
      return '.json'
    case 'image':
      return '.txt'
    default:
      return '.txt'
  }
}

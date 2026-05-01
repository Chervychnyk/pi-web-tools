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
  const normalizedHtml = normalizeHtmlForConversion(html, url)

  if (selector) {
    const selected = selectFragment(normalizedHtml, selector)
    return {
      title: extractHtmlTitle(normalizedHtml),
      byline: null,
      excerpt: null,
      siteName: null,
      contentHtml: selected.html,
      textContent: selected.text,
      extractionMethod: 'selector',
      selectedSelector: selector,
    }
  }

  const article = extractReadableArticle(normalizedHtml, url)
  if (article.textContent.length >= SELECTOR_FALLBACK_MIN_TEXT_LENGTH) {
    return article
  }

  const bestSelector = findBestContentSelector(normalizedHtml)
  if (!bestSelector || bestSelector.text.length <= article.textContent.length) {
    return article
  }

  return {
    title: article.title || extractHtmlTitle(normalizedHtml),
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

export function normalizeHtmlForConversion(html: string, url: string): string {
  const $ = cheerio.load(html)

  for (const element of $('[href], [src], [poster], [srcset]').toArray()) {
    const $element = $(element)

    for (const attribute of ['href', 'src', 'poster'] as const) {
      const value = $element.attr(attribute)
      if (!value) continue

      const resolved = resolveHtmlUrl(value, url, attribute !== 'href')
      if (resolved) $element.attr(attribute, resolved)
      else $element.removeAttr(attribute)
    }

    const srcset = $element.attr('srcset')
    if (srcset) {
      const resolved = resolveSrcset(srcset, url)
      if (resolved) $element.attr('srcset', resolved)
      else $element.removeAttr('srcset')
    }
  }

  normalizeBlockHeadingLinks($)
  flattenLayoutTables($)

  return $.html()
}

function normalizeBlockHeadingLinks($: cheerio.CheerioAPI) {
  $('a[href]').each((_, link) => {
    const $link = $(link)
    const children = $link.children().toArray()
    if (children.length !== 1) return

    const onlyChild = children[0]!
    if (!$(onlyChild).is('h1, h2, h3, h4, h5, h6')) return

    const replacementLink = $('<a></a>')
    const href = $link.attr('href')
    const title = $link.attr('title')
    if (href) replacementLink.attr('href', href)
    if (title) replacementLink.attr('title', title)
    replacementLink.html($(onlyChild).html() || '')
    $(onlyChild).empty().append(replacementLink)
    $link.replaceWith(onlyChild)
  })
}

function flattenLayoutTables($: cheerio.CheerioAPI) {
  const tables = $('table').toArray().reverse()
  for (const table of tables) {
    if (!isLikelyLayoutTable($, table)) continue

    $(table)
      .find('thead, tbody, tfoot, tr, td, th')
      .toArray()
      .reverse()
      .forEach((element) => replaceTag($, element, 'div'))
    replaceTag($, table, 'div')
  }
}

function isLikelyLayoutTable($: cheerio.CheerioAPI, table: cheerio.Element) {
  const $table = $(table)
  if ($table.find('caption, thead, th').length) return false
  if ($table.attr('role') === 'table' || $table.attr('role') === 'grid') return false
  if ($table.closest('#hnmain, #bigbox').length) return true
  if ($table.find('table').length) return true

  const layoutAttributes = ['align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'width']
  if (layoutAttributes.some((attribute) => $table.attr(attribute) !== undefined)) return true

  const rows = $table.find('tr').toArray().filter((row) => $(row).parents('table').first()[0] === table)
  if (!rows.length) return true

  const cellCounts = rows
    .map((row) => $(row).children('td, th').length)
    .filter((count) => count > 0)
  if (!cellCounts.length) return true
  if (Math.max(...cellCounts) <= 1) return true
  if (new Set(cellCounts).size > 1) return true

  const cells = rows.flatMap((row) => $(row).children('td, th').toArray())
  const averageCellTextLength =
    cells.reduce((total, cell) => total + normalizeWhitespace($(cell).text()).length, 0) /
    Math.max(1, cells.length)
  const linkCount = $table.find('a').toArray().filter((link) => $(link).parents('table').first()[0] === table).length
  return linkCount > cells.length * 0.6 && averageCellTextLength < 120
}

function replaceTag($: cheerio.CheerioAPI, element: cheerio.Element, tagName: string) {
  const replacement = $(`<${tagName}></${tagName}>`)
  replacement.html($(element).html() || '')
  $(element).replaceWith(replacement)
}

function resolveHtmlUrl(value: string, baseUrl: string, allowDataUrl: boolean) {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  try {
    const resolved = new URL(trimmed, baseUrl)
    if (resolved.protocol === 'javascript:' || resolved.protocol === 'vbscript:') return undefined
    if (resolved.protocol === 'data:' && !allowDataUrl) return undefined
    return resolved.toString()
  } catch {
    return undefined
  }
}

function resolveSrcset(srcset: string, baseUrl: string) {
  const candidates = srcset
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [urlPart, descriptor] = entry.split(/\s+/, 2)
      if (!urlPart) return undefined
      const resolved = resolveHtmlUrl(urlPart, baseUrl, true)
      if (!resolved) return undefined
      return descriptor ? `${resolved} ${descriptor}` : resolved
    })
    .filter((entry): entry is string => Boolean(entry))

  return candidates.length ? candidates.join(', ') : undefined
}

export function cleanupMarkdown(markdown: string): string {
  const normalizedMarkdown = markdown
    .replace(/\r\n/g, '\n')
    .replace(
      /\[\s*\n+(#{1,6})\s+([^\n]+?)\s*\n+\s*\]\(([^)]+)\)/g,
      (_match, hashes: string, text: string, url: string) =>
        `${hashes} [${text.trim()}](${url})`,
    )

  const lines = normalizedMarkdown.split('\n')
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

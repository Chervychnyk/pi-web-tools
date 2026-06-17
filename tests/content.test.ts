import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  buildJinaReaderUrl,
  cleanupMarkdown,
  extractBestHtmlContent,
  extractPdfText,
  isPdfMimeType,
  isPdfUrl,
  isPoorMarkdownConversion,
  looksLikeBlockedOrJunkContent,
  normalizeHtmlForConversion,
  shouldUseJinaFallbackForStatus,
} from '../web-fetch.ts'

function shouldAttemptStatusFallback(
  requestedFormat: string | undefined,
  selector: string | undefined,
  status: number,
) {
  return (
    !selector &&
    (requestedFormat === undefined ||
      requestedFormat === 'markdown' ||
      requestedFormat === 'text') &&
    shouldUseJinaFallbackForStatus(status)
  )
}

describe('normalizeHtmlForConversion', () => {
  it('lifts anchor wrappers from heading and resolves relative URLs', () => {
    const html = normalizeHtmlForConversion(
      '<html><body><a href="/story"><h2>Story title</h2></a></body></html>',
      'https://example.com/base/',
    )
    assert.match(html, /<h2><a href="https:\/\/example\.com\/story">Story title<\/a><\/h2>/)
  })

  it('expands relative href/src/srcset', () => {
    const html = normalizeHtmlForConversion(
      '<html><body><a href="/docs">Docs</a><img src="./image.png" srcset="small.png 1x, /large.png 2x"></body></html>',
      'https://example.com/base/index.html',
    )
    assert.match(html, /href="https:\/\/example\.com\/docs"/)
    assert.match(html, /src="https:\/\/example\.com\/base\/image\.png"/)
    assert.match(html, /https:\/\/example\.com\/base\/small\.png 1x/)
    assert.match(html, /https:\/\/example\.com\/large\.png 2x/)
  })

  it('strips nav and cookie-banner boilerplate', () => {
    const html = normalizeHtmlForConversion(
      '<html><body><nav>Navigation</nav><main><p>Article body</p></main><div class="cookie-banner">Cookies</div></body></html>',
      'https://example.com/',
    )
    assert.doesNotMatch(html, /Navigation|Cookies/)
    assert.match(html, /Article body/)
  })
})

describe('cleanupMarkdown', () => {
  it('collapses anchor wrapping around a heading', () => {
    assert.equal(
      cleanupMarkdown('[\n\n## Story title\n\n](https://example.com/story)'),
      '## [Story title](https://example.com/story)',
    )
  })
})

describe('isPoorMarkdownConversion', () => {
  it('flags content that is mostly divs/sections/tables', () => {
    assert.equal(
      isPoorMarkdownConversion(
        '<div>one</div><section>two</section><table><tr><td>three</td></tr></table>',
      ),
      true,
    )
  })
})

describe('extractBestHtmlContent', () => {
  it('reconstructs HN-style table layouts as a flat list', () => {
    const article = extractBestHtmlContent(
      `<html><body><div id="bigbox"><table><tbody>
        <tr><td>1.</td><td><a href="/item">Item title</a></td></tr>
        <tr><td></td><td>123 points by alice</td></tr>
      </tbody></table></div></body></html>`,
      'https://news.ycombinator.com/',
    )
    assert.match(article.contentHtml, /Item title/)
    assert.match(article.contentHtml, /123 points by alice/)
    assert.doesNotMatch(article.contentHtml, /<table|<tr|<td/i)
  })
})

describe('jina helpers', () => {
  it('builds a jina-reader URL by stripping the original protocol', () => {
    assert.equal(
      buildJinaReaderUrl('https://example.com/docs?q=1').toString(),
      'https://r.jina.ai/http://example.com/docs?q=1',
    )
  })

  it('flags retryable upstream status codes for the jina fallback', () => {
    assert.equal(shouldUseJinaFallbackForStatus(403), true)
    assert.equal(shouldUseJinaFallbackForStatus(429), true)
    assert.equal(shouldUseJinaFallbackForStatus(200), false)
  })

  it('refuses jina fallback for non-text-like formats or when a selector is set', () => {
    assert.equal(shouldAttemptStatusFallback(undefined, undefined, 403), true)
    assert.equal(shouldAttemptStatusFallback('markdown', undefined, 429), true)
    assert.equal(shouldAttemptStatusFallback('text', undefined, 503), true)
    assert.equal(shouldAttemptStatusFallback('html', undefined, 403), false)
    assert.equal(shouldAttemptStatusFallback('json', undefined, 403), false)
    assert.equal(shouldAttemptStatusFallback('markdown', 'main', 403), false)
  })

  it('recognises blocked / shell HTML content', () => {
    assert.equal(
      looksLikeBlockedOrJunkContent('Please enable JavaScript to continue'),
      true,
    )
    assert.equal(looksLikeBlockedOrJunkContent('Short text'), true)
    assert.equal(
      looksLikeBlockedOrJunkContent(
        'This is a long enough article body with meaningful content that should not be treated as blocked or junk because it contains explanatory sentences, structure, and enough text to pass the heuristic safely.',
      ),
      false,
    )
  })
})

describe('PDF helpers', () => {
  const minimalPdf = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT\n/F1 24 Tf\n72 100 Td\n(Hello PDF) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000241 00000 n \n0000000335 00000 n \ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n406\n%%EOF\n`,
  )

  it('recognises pdf MIME types and URLs', () => {
    assert.equal(isPdfMimeType('application/pdf'), true)
    assert.equal(isPdfMimeType('application/x-pdf'), true)
    assert.equal(isPdfMimeType('text/html'), false)
    assert.equal(isPdfUrl('https://example.com/spec.pdf'), true)
    assert.equal(isPdfUrl('https://example.com/spec.PDF?download=1'), true)
    assert.equal(isPdfUrl('https://example.com/docs'), false)
  })

  it('extracts text via pdftotext when the binary is available', async (t) => {
    try {
      execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
    } catch {
      t.skip('pdftotext binary not installed')
      return
    }
    const extracted = await extractPdfText(minimalPdf)
    assert.match(extracted, /Hello PDF/)
  })

  it('falls back to the JS extractor when pdftotext is unavailable', async () => {
    const previousPath = process.env.PATH
    process.env.PATH = ''
    try {
      const extracted = await extractPdfText(minimalPdf)
      assert.match(extracted, /Hello PDF/)
    } finally {
      process.env.PATH = previousPath
    }
  })
})

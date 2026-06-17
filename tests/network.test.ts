import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import {
  decodeBodyAsText,
  decodeContentEncoding,
  fetchWithOptionalCloudflareRetry,
  fetchWithRedirects,
  getResponseByteLimit,
  isBlockedHostname,
  isPrivateIpAddress,
  MAX_HTML_BYTES,
  MAX_IMAGE_RESPONSE_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  MAX_PDF_RESPONSE_BYTES,
  MAX_TEXT_RESPONSE_BYTES,
  parseCharsetFromContentType,
  parseContentLength,
  shouldApplyHtmlGuard,
  type GuardedRequester,
} from '../web-fetch.ts'
import { createResponse } from './helpers.ts'

describe('fetchWithRedirects', () => {
  it('follows redirects and reports the final URL', async () => {
    const visited: string[] = []
    const redirectingRequester: GuardedRequester = async (url) => {
      visited.push(url.toString())
      if (url.pathname === '/start') {
        return createResponse(url.toString(), 302, { location: '/final' })
      }
      return createResponse(url.toString(), 200)
    }

    const redirected = await fetchWithRedirects(
      new URL('https://example.com/start'),
      new AbortController().signal,
      'agent',
      redirectingRequester,
    )
    assert.equal(redirected.url, 'https://example.com/final')
    assert.deepEqual(visited, [
      'https://example.com/start',
      'https://example.com/final',
    ])
  })

  it('rejects when a redirect lands on a blocked hostname', async () => {
    const blockedRedirect: GuardedRequester = async () =>
      createResponse('https://example.com/start', 302, {
        location: 'http://localhost/admin',
      })
    await assert.rejects(
      () =>
        fetchWithRedirects(
          new URL('https://example.com/start'),
          new AbortController().signal,
          'agent',
          blockedRedirect,
        ),
      /Blocked hostname: localhost/,
    )
  })

  it('caps redirect chains and rejects loops', async () => {
    const looping: GuardedRequester = async (url) =>
      createResponse(url.toString(), 302, { location: '/loop' })
    await assert.rejects(
      () =>
        fetchWithRedirects(
          new URL('https://example.com/loop'),
          new AbortController().signal,
          'agent',
          looping,
        ),
      /Too many redirects/,
    )
  })

  it('propagates AbortError when the signal aborts mid-flight', async () => {
    const controller = new AbortController()
    const abortingRequester: GuardedRequester = async (_url, signal) => {
      await Promise.resolve()
      controller.abort()
      if (signal.aborted) {
        const error = new Error('request aborted')
        error.name = 'AbortError'
        throw error
      }
      return createResponse('https://example.com/never', 200)
    }
    await assert.rejects(
      () =>
        fetchWithRedirects(
          new URL('https://example.com/data'),
          controller.signal,
          'agent',
          abortingRequester,
        ),
      /request aborted/,
    )
  })
})

describe('fetchWithOptionalCloudflareRetry', () => {
  it('retries with the fallback User-Agent when Cloudflare blocks the first attempt', async () => {
    const userAgents: string[] = []
    const updates: string[] = []
    let attempts = 0
    const cloudflareRequester: GuardedRequester = async (url, _signal, userAgent) => {
      attempts += 1
      userAgents.push(userAgent)
      if (attempts === 1) {
        return createResponse(url.toString(), 403, {
          server: 'cloudflare',
          'cf-mitigated': 'challenge',
        })
      }
      return createResponse(url.toString(), 200)
    }

    const retried = await fetchWithOptionalCloudflareRetry(
      new URL('https://example.com/docs'),
      new AbortController().signal,
      (update) => {
        updates.push(update.content.map((item) => item.text).join('\n'))
      },
      cloudflareRequester,
    )
    assert.equal(retried.cloudflareBypassed, true)
    assert.equal(retried.response.status, 200)
    assert.match(userAgents[0] || '', /Mozilla\/5\.0/)
    assert.equal(userAgents[1], 'pi-web-fetch/1.1')
    assert.ok(updates.some((text) => text.includes('Cloudflare challenge detected')))
  })
})

describe('proxy validation', () => {
  it('rejects unsupported protocols', async () => {
    await assert.rejects(
      () =>
        fetchWithOptionalCloudflareRetry(
          new URL('https://example.com/docs'),
          new AbortController().signal,
          undefined,
          undefined,
          { proxy: 'ftp://proxy.example:21' },
        ),
      /Unsupported proxy protocol: ftp:/,
    )
  })

  it('accepts socks5h:// proxies', async () => {
    // We don't run the network call; just confirm the proxy parser doesn't
    // reject the protocol. The requester throws so we catch that instead.
    const requester: GuardedRequester = async () => {
      throw new Error('reached fetcher')
    }
    await assert.rejects(
      () =>
        fetchWithOptionalCloudflareRetry(
          new URL('https://example.com/docs'),
          new AbortController().signal,
          undefined,
          requester,
          { proxy: 'socks5h://proxy.example:1080' },
        ),
      /reached fetcher/,
      'parser accepted socks5h; fetcher executed',
    )
  })

  it('rejects non-loopback private IPs as proxy hosts', async () => {
    await assert.rejects(
      () =>
        fetchWithOptionalCloudflareRetry(
          new URL('https://example.com/docs'),
          new AbortController().signal,
          undefined,
          undefined,
          { proxy: 'http://10.0.0.1:8080' },
        ),
      /Blocked private network address: 10\.0\.0\.1/,
    )
  })

  it('allows localhost / 127.0.0.1 / ::1 as proxy hosts', async () => {
    const requester: GuardedRequester = async () => {
      throw new Error('reached fetcher')
    }
    for (const proxy of [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
    ]) {
      await assert.rejects(
        () =>
          fetchWithOptionalCloudflareRetry(
            new URL('https://example.com/docs'),
            new AbortController().signal,
            undefined,
            requester,
            { proxy },
          ),
        /reached fetcher/,
        `loopback proxy accepted: ${proxy}`,
      )
    }
  })
})

describe('response decoding', () => {
  it('decodes gzip/deflate/brotli content', () => {
    const plain = Buffer.from('Hello café', 'utf8')
    assert.equal(decodeContentEncoding(gzipSync(plain), 'gzip').toString('utf8'), 'Hello café')
    assert.equal(decodeContentEncoding(deflateSync(plain), 'deflate').toString('utf8'), 'Hello café')
    assert.equal(
      decodeContentEncoding(brotliCompressSync(plain), 'br').toString('utf8'),
      'Hello café',
    )
  })

  it('decodes layered encodings in the order listed', () => {
    const layered = brotliCompressSync(gzipSync(Buffer.from('Hello café', 'utf8')))
    assert.equal(
      decodeContentEncoding(layered, 'gzip, br').toString('utf8'),
      'Hello café',
    )
  })

  it('throws on unsupported encodings', () => {
    assert.throws(
      () => decodeContentEncoding(Buffer.from('hi'), 'compress'),
      /Unsupported content-encoding/,
    )
  })

  it('reads charset from Content-Type header', () => {
    assert.equal(parseCharsetFromContentType('text/plain; charset=ISO-8859-1'), 'iso-8859-1')
  })

  it('decodes latin1-tagged body as latin1 text', () => {
    const latin1 = Buffer.from('café', 'latin1')
    assert.equal(decodeBodyAsText(latin1, 'text/plain; charset=iso-8859-1'), 'café')
  })
})

describe('fetch guards', () => {
  it('parses content-length safely', () => {
    assert.equal(parseContentLength(null), undefined)
    assert.equal(parseContentLength('1234'), 1234)
    assert.equal(parseContentLength('abc'), undefined)
  })

  it('returns per-MIME byte limits from the exported constants', () => {
    assert.equal(getResponseByteLimit('text/html'), MAX_HTML_BYTES)
    assert.equal(getResponseByteLimit('application/json'), MAX_JSON_RESPONSE_BYTES)
    assert.equal(getResponseByteLimit('application/pdf'), MAX_PDF_RESPONSE_BYTES)
    assert.equal(getResponseByteLimit('image/png'), MAX_IMAGE_RESPONSE_BYTES)
    assert.equal(getResponseByteLimit('text/plain'), MAX_TEXT_RESPONSE_BYTES)
  })

  it('blocks special hostnames', () => {
    assert.equal(isBlockedHostname('localhost'), true)
    assert.equal(isBlockedHostname('api.localhost'), true)
    assert.equal(isBlockedHostname('host.docker.internal'), true)
    assert.equal(isBlockedHostname('metadata.google.internal'), true)
    assert.equal(isBlockedHostname('example.com'), false)
  })

  it('recognises private/reserved IP ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.8',
      '172.16.5.4',
      '192.168.1.10',
      '169.254.169.254',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      assert.equal(isPrivateIpAddress(ip), true, `${ip} should be private`)
    }
    assert.equal(isPrivateIpAddress('8.8.8.8'), false)
    assert.equal(isPrivateIpAddress('2606:4700:4700::1111'), false)
  })

  it('applies the HTML byte-size guard only for HTML+text-like formats', () => {
    assert.equal(shouldApplyHtmlGuard('text/html', 'markdown', MAX_HTML_BYTES + 1), true)
    assert.equal(shouldApplyHtmlGuard('text/html', 'json', MAX_HTML_BYTES + 1), false)
    assert.equal(shouldApplyHtmlGuard('application/json', 'markdown', MAX_HTML_BYTES + 1), false)
    assert.equal(shouldApplyHtmlGuard('text/html', 'markdown', 1024), false)
  })
})

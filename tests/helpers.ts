import { Buffer } from 'node:buffer'
import {
  createBatchWebFetchTool,
  createWebFetchTool,
  type GuardedFetchResponse,
} from '../web-fetch.ts'

type CreateWebFetchToolDeps = Parameters<typeof createWebFetchTool>[0]

export function createHeaders(entries: Record<string, string>) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(entries)) headers.set(key, value)
  return headers
}

export function createResponse(
  url: string,
  status: number,
  headers: Record<string, string> = {},
): GuardedFetchResponse {
  return {
    url,
    status,
    statusText:
      status === 200 ? 'OK' : status === 302 ? 'Found' : status === 403 ? 'Forbidden' : '',
    headers: createHeaders(headers),
    ok: status >= 200 && status < 300,
    bodyBuffer: Buffer.from('test'),
  }
}

// Fail-loud defaults: every dep throws unless the test overrides it. Tests
// stay terse — they say what they care about, not what they don't.
const failJina = () => {
  throw new Error('jinaFetcher should not be called by this test')
}
const failPdf = () => {
  throw new Error('pdfTextExtractor should not be called by this test')
}
const failNetwork = () => {
  throw new Error('networkFetcher should not be called by this test')
}
const noGitHub = async () => null

export function buildFetchTool(overrides: NonNullable<CreateWebFetchToolDeps> = {}) {
  return createWebFetchTool({
    githubFetcher: noGitHub,
    networkFetcher: failNetwork as never,
    jinaFetcher: failJina as never,
    pdfTextExtractor: failPdf as never,
    ...overrides,
  })
}

export function buildBatchFetchTool(overrides: NonNullable<CreateWebFetchToolDeps> = {}) {
  return createBatchWebFetchTool({
    githubFetcher: noGitHub,
    networkFetcher: failNetwork as never,
    jinaFetcher: failJina as never,
    pdfTextExtractor: failPdf as never,
    ...overrides,
  })
}

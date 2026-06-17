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

// Narrows the union (TextContent | ImageContent)[] down to the text payload.
// Throws if no text block exists — tests want a definite string, not an
// undefined-walk through optional chaining.
export function getTextContent(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  const block = content.find((c) => c.type === 'text')
  if (!block || typeof block.text !== 'string') {
    throw new Error('Expected a text content block in tool result')
  }
  return block.text
}

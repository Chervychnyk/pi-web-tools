import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { createBatchWebFetchTool, createWebFetchTool } from './fetch/tool.ts'

export type {
  BatchFetchDetails,
  BatchFetchItemSummary,
  FetchDetails,
  GuardedFetchResponse,
  GuardedRequester,
} from './fetch/types.ts'
export type { WebFetchDependencies } from './fetch/tool.ts'
export {
  buildJinaReaderUrl,
  decodeBodyAsText,
  decodeContentEncoding,
  extractPdfText,
  fetchWithOptionalCloudflareRetry,
  fetchWithRedirects,
  getResponseByteLimit,
  isBlockedHostname,
  isPdfMimeType,
  isPdfUrl,
  isPrivateIpAddress,
  looksLikeBlockedOrJunkContent,
  MAX_IMAGE_RESPONSE_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  MAX_OTHER_RESPONSE_BYTES,
  MAX_PDF_RESPONSE_BYTES,
  MAX_TEXT_RESPONSE_BYTES,
  parseCharsetFromContentType,
  parseContentLength,
  shouldApplyHtmlGuard,
  shouldUseJinaFallbackForStatus,
} from './fetch/network.ts'
export { createBatchWebFetchTool, createWebFetchTool } from './fetch/tool.ts'

export function registerWebFetchTool(pi: ExtensionAPI) {
  pi.registerTool(createWebFetchTool())
  pi.registerTool(createBatchWebFetchTool())
}

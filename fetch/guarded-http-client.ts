import type {
  FetchProgressHandler,
  FetchRequestOptions,
  GuardedFetchResponse,
  GuardedRequester,
} from './types.ts'
import { assertSafeFetchUrl, requestWithDnsGuard } from './network.ts'

const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const FETCH_USER_AGENT =
  process.env.PI_WEB_FETCH_USER_AGENT?.trim() || DEFAULT_BROWSER_USER_AGENT
const FETCH_USER_AGENT_FALLBACK =
  process.env.PI_WEB_FETCH_FALLBACK_USER_AGENT?.trim() || 'pi-web-fetch/1.1'
const MAX_REDIRECTS = 5

function isRedirectStatus(status: number) {
  return [301, 302, 303, 307, 308].includes(status)
}

export async function fetchWithRedirects(
  initialUrl: URL,
  signal: AbortSignal,
  userAgent: string,
  requester: GuardedRequester = requestWithDnsGuard,
  options?: FetchRequestOptions,
): Promise<GuardedFetchResponse> {
  let currentUrl = new URL(initialUrl.toString())

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    const response = await requester(currentUrl, signal, userAgent, options)
    if (!isRedirectStatus(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(
        `Too many redirects while fetching ${initialUrl.toString()}`,
      )
    }

    currentUrl = new URL(location, currentUrl)
    assertSafeFetchUrl(currentUrl)
  }

  throw new Error(`Too many redirects while fetching ${initialUrl.toString()}`)
}

function isCloudflareChallenge(response: GuardedFetchResponse) {
  const server = (response.headers.get('server') || '').toLowerCase()
  return (
    response.status === 403 &&
    (response.headers.get('cf-mitigated') === 'challenge' ||
      server.includes('cloudflare'))
  )
}

export async function fetchWithOptionalCloudflareRetry(
  url: URL,
  signal: AbortSignal,
  onUpdate?: FetchProgressHandler,
  requester: GuardedRequester = requestWithDnsGuard,
  options?: FetchRequestOptions,
) {
  let response = await fetchWithRedirects(
    url,
    signal,
    FETCH_USER_AGENT,
    requester,
    options,
  )
  let cloudflareBypassed = false

  if (isCloudflareChallenge(response)) {
    cloudflareBypassed = true
    onUpdate?.({
      content: [
        {
          type: 'text',
          text: 'Cloudflare challenge detected, retrying with fallback User-Agent...',
        },
      ],
    })
    response = await fetchWithRedirects(
      url,
      signal,
      FETCH_USER_AGENT_FALLBACK,
      requester,
      options,
    )
  }

  return { response, cloudflareBypassed }
}

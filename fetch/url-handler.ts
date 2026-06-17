import type {
  FetchDetails,
  FetchProgressHandler,
  FetchToolContent,
  ParsedFetchParams,
} from './types.ts'

export type FetchResult = {
  content: FetchToolContent
  details: FetchDetails
}

export type HandlerContext = {
  // URL this handler is being invoked on. Matches parsed.parsedUrl on the
  // first dispatch, but differs after redirect re-dispatch.
  url: URL
  parsed: ParsedFetchParams
  signal: AbortSignal
  onUpdate?: FetchProgressHandler
  cacheKey: string
  // Re-dispatch on a resolved URL (e.g. after HTTP redirects).
  // Returns null if no other handler claims the URL — caller stays on its
  // own path with whatever it already fetched.
  dispatch(finalUrl: URL): Promise<FetchResult | null>
}

export type UrlHandler = {
  name: string
  match(url: URL): boolean
  validate(parsed: ParsedFetchParams): void
  // Return null to fall through to the next matching handler.
  // Throw to surface a hard error.
  fetch(ctx: HandlerContext): Promise<FetchResult | null>
}

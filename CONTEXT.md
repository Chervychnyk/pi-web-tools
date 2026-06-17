# pi-web-tools — domain vocabulary

Architectural terms specific to this codebase. Use these names exactly when
discussing or extending the modules listed below.

## UrlHandler

A `UrlHandler` (`fetch/url-handler.ts`) is the seam at which the `web_fetch`
tool dispatches a request to an appropriate fetching strategy. Each handler
exposes:

- `match(url)` — does this handler claim this URL?
- `validate(parsed)` — throws if the request params are statically
  incompatible with the handler (e.g. GitHub URLs reject `selector`)
- `fetch(ctx)` — returns a `FetchResult` or `null` to fall through to the
  next matching handler

Two concrete handlers live in `fetch/handlers/`:

- `GitHubHandler` — recognises `github.com` URLs, delegates to
  `fetchGitHubContent` which clones or uses the GitHub API
- `DefaultHttpHandler` — catch-all for ordinary HTTP requests. Owns the
  classify/extract/assemble pipeline, including binary streaming and the
  Jina Reader fallback

## Dispatch loop

The `web_fetch` tool's `execute()` runs a single `runHandler(url, depth, strict)`
that walks `handlers` in order and runs the first one whose `match` and
`validate` succeed. `fetch` returning `null` means "I matched but didn't
actually handle this; try the next handler" — `DefaultHttpHandler` always
matches and never returns `null`, so dispatch is total.

Re-dispatch happens through `ctx.dispatch(finalUrl)`, available on every
`HandlerContext`. Currently only `DefaultHttpHandler` uses it: after
following HTTP redirects, if the final URL routes to a different handler
(e.g. a redirect to `github.com`), HTTP drops its already-fetched body and
hands off.

Two safeguards prevent runaway dispatch:

- `depth > 1` throws — a re-dispatched handler cannot re-dispatch again
- Same-handler short-circuit — if `dispatch(next)` would route back to the
  current handler, it returns `null` immediately and the current handler
  continues with what it has

`validate` errors propagate strictly on the entry-point call (so users get
a clear "selector is not supported for GitHub URLs" error) and silently
turn into `null` on re-dispatch (so an HTTP→GitHub redirect with an
incompatible selector falls back to HTTP rather than erroring).

Registering custom handlers: `createWebFetchTool({ urlHandlers: [...] })`
replaces the default prepended list. `DefaultHttpHandler` is always
appended last and cannot be overridden through this seam.

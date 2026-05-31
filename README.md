# pi-web-tools

Small Pi package for practical web access without the complexity of `pi-web-access`.

It provides:

- `web_search`
- `web_fetch`
- `batch_web_fetch`
- `get_web_content`
- `list_web_content`
- bundled skills:
  - `web-search`
  - `web-fetch`

## Why this package exists

This package keeps the useful parts of web access local and understandable:

- provider-based web search with fallback
- optional persisted provider configuration with env-var overrides
- readable page fetch and extraction
- persisted `responseId` retrieval to avoid context bloat
- GitHub-aware fetches
- lightweight Jina fallback for blocked JS-heavy pages
- PDF text extraction with `pdftotext` + JS fallback (`unpdf`)

It intentionally avoids the heavier workflow/orchestration surface from `pi-web-access`.

## Install in Pi

Install directly from git:

```bash
pi install git@github.com:Chervychnyk/pi-web-tools.git
```

Or use the HTTPS remote:

```bash
pi install https://github.com/Chervychnyk/pi-web-tools.git
```

If you prefer wiring it manually in `settings.json`, reference the git URL instead of a local path:

```json
{
  "packages": [
    "git@github.com:Chervychnyk/pi-web-tools.git"
  ]
}
```

Because this repository is a Pi package, Pi will load:

- the extension from `index.ts`
- skills from `skills/`

## Tools

### `web_search`

Search the web with provider auto-detection and fallback.

Features:

- single `query` or batched `queries`
- provider fallback
- per-query result limits
- compact inline previews for batched searches to reduce token usage
- cached responses
- persisted `responseId` storage for full follow-up retrieval

Example:

```ts
web_search({ query: "latest TypeScript 2026 release notes" })
web_search({ queries: ["pi extension docs", "pi package docs"] })
```

### `web_fetch`

Fetch and extract content from URLs.

Features:

- `markdown`, `text`, `html`, `json`, `image`
- Readability extraction
- CSS selector extraction
- optional custom `headers` and `proxy`
- structured error metadata (`code`, `phase`, `retryable`) in failure messages
- GitHub-aware repo/tree/blob handling (local clone first, GitHub API fallback for commit-SHA URLs and clone failures)
- automatic switch to GitHub extraction when a non-GitHub URL redirects to github.com
- Jina Reader fallback for blocked markdown/text fetches
- PDF extraction via `pdftotext` with JS fallback (`unpdf`)
- persisted `responseId` storage
- binary/attachment download mode streamed to temp files (`filePath`, `fileSize`, `fileName`)
- streamed download guards with per-content-type byte caps

Examples:

```ts
web_fetch({ url: "https://example.com/article" })
web_fetch({ url: "https://github.com/owner/repo" })
web_fetch({
  url: "https://api.example.com/private",
  format: "json",
  headers: { Authorization: "Bearer <token>" },
})
web_fetch({
  url: "https://example.com/spec.pdf",
  format: "text",
  proxy: "http://proxy.example:8080",
})
web_fetch({ url: "https://example.com/release.zip" }) // downloads to temp file and returns metadata
```

### `batch_web_fetch`

Fetch multiple URLs with bounded concurrency. Each request accepts the same
parameters as `web_fetch`.

The tool streams partial progress with per-item status rows and returns final
per-item outcome metadata.

Examples:

```ts
batch_web_fetch({
  requests: [
    { url: "https://example.com/a", format: "markdown" },
    { url: "https://example.com/b", format: "text" },
    { url: "https://api.example.com/c", format: "json", headers: { Authorization: "Bearer <token>" } },
  ],
  concurrency: 3,
})
```

### `get_web_content`

Retrieve stored full content from earlier `web_search` or `web_fetch` calls. Output includes source context such as URL, title, format, search provider, and result count before the stored content.

Examples:

```ts
get_web_content({ responseId: "wt_..." })
get_web_content({ responseId: "wt_...", queryIndex: 0 })
get_web_content({ responseId: "wt_...", offset: 201, limit: 200 })
```

### `list_web_content`

List recent stored responses when you need to recover which `responseId` belongs to which URL or search query.

Examples:

```ts
list_web_content()
list_web_content({ kind: "fetch", limit: 10 })
```

## Skills

### `web-search`

Guides Pi toward using:

- `web_search`
- `get_web_content`

### `web-fetch`

Guides Pi toward using:

- `web_fetch`
- `batch_web_fetch`
- `get_web_content`

## Package layout

- `index.ts` — extension entrypoint
- `web-search.ts` — `web_search`
- `web-fetch.ts` — public `web_fetch` / `batch_web_fetch` exports + registration
- `fetch/` — web fetch internals (network guards, extraction, tool implementation, shared fetch types)
- `get-web-content.ts` — stored-content retrieval
- `list-web-content.ts` — stored response index/listing
- `storage.ts` — persisted response store
- `github.ts` — public GitHub helpers + fetch orchestration
- `github-support/` — GitHub cache, CLI, URL parsing, and rendering internals
- `providers/` — web search providers
- `skills/` — bundled Pi skills
- `tests.ts` — local test runner
- `tests/` — focused structural and mocked execute-path tests by subsystem

## Local development

Run tests:

```bash
cd ~/code/pi-web-tools
npm test
```

Notes:

- tests do not hit live provider APIs
- PDF extraction test auto-skips the `pdftotext` path when the binary is unavailable
- runtime PDF extraction prefers `pdftotext` and falls back to JS-based extraction via `unpdf`
- GitHub repository fetches prefer local clones via `git`; `gh` is used when available for auth-aware clone/ref operations
- commit-SHA GitHub URLs and clone failures automatically fall back to GitHub API views
- ambiguous GitHub branch/tag paths are only resolved via remote metadata after an initial direct attempt fails

## Configuration

Search provider environment variables:

- `PI_WEB_SEARCH_PROVIDER` — preferred default provider (`auto`, `duckduckgo`, `brave`, `kagi`, `google`, `searxng`)
- `BRAVE_API_KEY`
- `KAGI_API_KEY`
- `GOOGLE_API_KEY`
- `GOOGLE_CX`
- `SEARXNG_URL`

You can also run `/web-search-config` in an interactive Pi session to write persisted search settings to `~/.config/pi-web-tools/config.json` with file mode `0600`. Environment variables take precedence over persisted values.

Example config:

```json
{
  "provider": "brave",
  "apiKeys": {
    "brave": "...",
    "kagi": "...",
    "google": "...",
    "googleCx": "..."
  },
  "baseUrls": {
    "searxng": "http://localhost:8080"
  },
  "guidance": {
    "web_search": {
      "promptSnippet": "Search current public documentation",
      "promptGuidelines": [
        "Use this only when current external facts are needed."
      ]
    },
    "web_fetch": {
      "promptSnippet": "Fetch and extract a specific URL"
    }
  }
}
```

`guidance` entries are optional per-tool overrides for `promptSnippet` and `promptGuidelines`. Supported keys include `web_search`, `web_fetch`, and `batch_web_fetch`.

GitHub environment variables (optional, for higher API rate limits/private fallback access):

- `GITHUB_TOKEN`
- `GH_TOKEN`

Cache/storage environment variables:

- `PI_WEB_TOOLS_STORAGE_DIR` — root for stored `responseId` content
- `PI_WEB_TOOLS_GITHUB_DIR` — root for GitHub clone cache
- `PI_WEB_TOOLS_STORAGE_MAX_AGE_MS` — optional max age (ms) before stored response files are pruned (default: 14 days)
- `XDG_CACHE_HOME` — optional fallback base on Linux-like systems when explicit dirs are not set

Behavior notes:

- batched `web_search` responses intentionally return a compact inline preview; use `responseId` + `get_web_content` for the full stored result set
- `web_fetch` and `batch_web_fetch` store full text responses when possible, then trim/truncate inline output for model safety
- in-memory caching is intentionally biased toward smaller text responses; large text payloads and image responses are not memoized in RAM
- if no explicit storage dir is configured and `~/.pi/cache/web-tools` is unavailable, the package falls back to a writable cache directory under the system temp directory
- GitHub clones are refreshed automatically when stale, and old clone caches are pruned over time
- stored response files are pruned by both count and age
- explicit cache dirs are respected as-is; fallback paths are only used when no explicit dir is configured
- proxy endpoints are security-validated and must resolve to public addresses (localhost/private/link-local proxies are rejected)

## Security note: `web_fetch` host guard

`web_fetch` only supports `http` and `https` URLs and rejects loopback, private, link-local, multicast/reserved, and common metadata hostnames before making requests. Unlike simple host-literal guards, it validates DNS results through a guarded lookup path and re-validates redirect targets. Proxy endpoints are checked with the same public-address rules.

This reduces SSRF risk for model-driven fetches, but it is still not a replacement for network-level egress controls in hostile automation environments.

## Storage and cache

Stored response content:

- default: `~/.pi/cache/web-tools/responses/`
- fallback: system temp cache when the default path is not writable

GitHub clone cache:

- default: `~/.pi/cache/web-tools/github/`
- fallback: system temp cache when the default path is not writable
- freshness metadata is stored separately under a hidden `.meta/` directory inside the GitHub cache root

These paths are safe to ignore in git.

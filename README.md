# pi-web-tools

Small Pi package for practical web access without the complexity of `pi-web-access`.

It provides:

- `web_search`
- `web_fetch`
- `get_web_content`
- bundled skills:
  - `web-search`
  - `web-fetch`

## Why this package exists

This package keeps the useful parts of web access local and understandable:

- provider-based web search with fallback
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
- cached responses
- persisted `responseId` storage

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
- GitHub-aware repo/tree/blob handling (local clone first, GitHub API fallback for commit-SHA URLs and clone failures)
- automatic switch to GitHub extraction when a non-GitHub URL redirects to github.com
- Jina Reader fallback for blocked markdown/text fetches
- PDF extraction via `pdftotext` with JS fallback (`unpdf`)
- persisted `responseId` storage
- streamed download guards with per-content-type byte caps

Examples:

```ts
web_fetch({ url: "https://example.com/article" })
web_fetch({ url: "https://github.com/owner/repo" })
web_fetch({ url: "https://example.com/spec.pdf", format: "text" })
```

### `get_web_content`

Retrieve stored full content from earlier `web_search` or `web_fetch` calls.

Examples:

```ts
get_web_content({ responseId: "wt_..." })
get_web_content({ responseId: "wt_...", queryIndex: 0 })
get_web_content({ responseId: "wt_...", offset: 201, limit: 200 })
```

## Skills

### `web-search`

Guides Pi toward using:

- `web_search`
- `get_web_content`

### `web-fetch`

Guides Pi toward using:

- `web_fetch`
- `get_web_content`

## Package layout

- `index.ts` — extension entrypoint
- `web-search.ts` — `web_search`
- `web-fetch.ts` — public `web_fetch` exports + registration
- `fetch/` — web fetch internals (network guards, extraction, tool implementation, shared fetch types)
- `get-web-content.ts` — stored-content retrieval
- `storage.ts` — persisted response store
- `github.ts` — public GitHub helpers + fetch orchestration
- `github-support/` — GitHub cache, CLI, URL parsing, and rendering internals
- `providers/` — web search providers
- `skills/` — bundled Pi skills
- `tests.ts` — local structural and mocked execute-path tests

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

## Configuration

Search provider environment variables:

- `PI_WEB_SEARCH_PROVIDER` — preferred default provider (`auto`, `duckduckgo`, `brave`, `kagi`, `google`, `searxng`)
- `BRAVE_API_KEY`
- `KAGI_API_KEY`
- `GOOGLE_API_KEY`
- `GOOGLE_CX`
- `SEARXNG_URL`

GitHub environment variables (optional, for higher API rate limits/private fallback access):

- `GITHUB_TOKEN`
- `GH_TOKEN`

Cache/storage environment variables:

- `PI_WEB_TOOLS_STORAGE_DIR` — root for stored `responseId` content
- `PI_WEB_TOOLS_GITHUB_DIR` — root for GitHub clone cache
- `PI_WEB_TOOLS_STORAGE_MAX_AGE_MS` — optional max age (ms) before stored response files are pruned (default: 14 days)
- `XDG_CACHE_HOME` — optional fallback base on Linux-like systems when explicit dirs are not set

Behavior notes:

- if no explicit storage dir is configured and `~/.pi/cache/web-tools` is unavailable, the package falls back to a writable cache directory under the system temp directory
- GitHub clones are refreshed automatically when stale, and old clone caches are pruned over time
- stored response files are pruned by both count and age
- explicit cache dirs are respected as-is; fallback paths are only used when no explicit dir is configured

## Storage and cache

Stored response content:

- default: `~/.pi/cache/web-tools/responses/`
- fallback: system temp cache when the default path is not writable

GitHub clone cache:

- default: `~/.pi/cache/web-tools/github/`
- fallback: system temp cache when the default path is not writable
- freshness metadata is stored separately under a hidden `.meta/` directory inside the GitHub cache root

These paths are safe to ignore in git.

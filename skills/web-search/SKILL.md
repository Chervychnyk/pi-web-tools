---
name: web-search
description: Search the web for current information using web_search, then browse stored results with get_web_content.
---

# web-search

Search the web for current information and documentation using the `web_search` tool.

## Workflows

### Find current information

Use `web_search` with a single `query` when you need current docs, news, release notes, or API information.

- Search first, then use `web_fetch` to read a specific result URL.
- Keep `limit` small (default 5) unless the user asks for broad exploration.
- Results include titles, URLs, and snippets — often enough to answer without fetching.

### Deep research with multiple angles

Use `web_search` with `queries` (2-6) when a single query won't cover the topic.

- Each query should be a distinct search angle, not a rephrasing of the same question.
- Example: researching a library might need queries for "docs", "changelog", and "migration guide".
- Results are grouped per query in the output.

### Browse stored results

When `web_search` returns a `responseId`, use `get_web_content` to page through the full stored output without rerunning the search.

- `get_web_content({ responseId })` — retrieve the full stored result.
- `offset` / `limit` — page through long results (default 200 lines per page).
- `query` or `queryIndex` — select a specific query from multi-query results.

## Behavior notes

- Results are cached for 5 minutes. Use `refresh: true` to bypass the cache and force a fresh search.
- Provider is auto-detected from environment (Brave, Kagi, Google, SearXNG, DuckDuckGo fallback). Override with `provider` parameter.
- After finding a relevant URL, use `web_fetch` to retrieve the full page content.

## Tool reference

### web_search

| Parameter | Description |
|-----------|-------------|
| `query` | Single search query |
| `queries` | Batch of 2-6 distinct queries (use instead of `query`) |
| `provider` | Optional: `auto`, `duckduckgo`, `brave`, `kagi`, `google`, `searxng` |
| `limit` | Max results per query (default 5, max 20) |
| `timeout` | Request timeout in ms (default 10000) |
| `maxChars` | Character cap for formatted output |
| `refresh` | Bypass cache (default false) |

### get_web_content

| Parameter | Description |
|-----------|-------------|
| `responseId` | Stored response ID from a prior `web_search` or `web_fetch` |
| `query` | Select a specific query from multi-query results |
| `queryIndex` | Zero-based index alternative to `query` |
| `offset` | Line offset to start from (1-indexed, default 1) |
| `limit` | Max lines to return (default 200, max 1000) |
| `maxChars` | Character cap for output |

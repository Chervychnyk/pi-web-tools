---
name: web-search
description: Use the web_search tool to search the web for current information and documentation.
---

# web-search

Use the `web_search` extension tool when you need current information from the web.

## Preferred tool

- `web_search`
  - `query` — single search query
  - `queries` — optional small batch of distinct queries
  - `limit` — optional result count per query
  - `timeout` — optional request timeout in milliseconds
  - `maxChars` — optional character cap for formatted search output
- `get_web_content`
  - `responseId` — retrieve stored full content from a prior `web_search` or `web_fetch`
  - `query` / `queryIndex` — optional selector for multi-query search results
  - `offset` / `limit` — page through long stored content

## Guidance

- Search first when you need current docs, news, release notes, or recent API information.
- Use `queries` when broader research needs 2-6 distinct search angles.
- Keep `limit` small unless the user asks for broad exploration.
- Use `web_fetch` after this when you need the full contents of a specific result.
- When `web_search` returns a `responseId`, use `get_web_content` to page back the full stored output without rerunning the search.

---
name: web-fetch
description: Fetch a URL and extract readable content using web_fetch, then browse stored results with get_web_content.
---

# web-fetch

Fetch and extract content from URLs using the `web_fetch` tool.

## Workflows

### Read a web page

Use `web_fetch` with `format: "markdown"` (default) or `"text"` to extract readable content from a URL.

- Markdown uses Readability extraction for clean article content.
- JS-heavy or blocked pages automatically fall back through Jina Reader.
- Use `selector` (CSS selector) to extract a specific region, e.g. `article`, `main`, `#content`. Only works for HTML/XHTML responses.
- Pair with `web_search` when you need to discover the right URL first.
- For pages that may be long, set `maxChars` on the initial fetch and use `get_web_content` if you need the full stored text later.

### Fetch structured data

- `format: "json"` — fetch and pretty-print JSON from API endpoints.
- `format: "html"` — fetch raw HTML markup. Supports `selector` for extraction.
- `format: "image"` — fetch an image and return it inline (auto-detected for image content types).

### Work with special URLs

- **GitHub repositories** — root URLs return repo summary with README and tree. Tree URLs return directory listings. Blob URLs return file content. Uses a local clone for speed; falls back to GitHub API. Only `markdown` and `text` output supported.
- **PDF URLs** — text extracted via `pdftotext` with a JS fallback (`unpdf`). Only `markdown` and `text` output supported.

### Retrieve stored content

When `web_fetch` returns a `responseId`, use `get_web_content` to page through the full stored content without refetching.

- `get_web_content({ responseId })` — retrieve the stored result.
- `offset` / `limit` — page through long content (default 200 lines per page).
- Large responses are truncated with full output saved to a temp file.
- Prefer paging stored content over repeatedly refetching the same long page.

## Behavior notes

- Fetched content is cached for 10 minutes. Use `refresh: true` to bypass.
- Very large HTML responses (>5MB) are rejected to avoid expensive parsing.
- Images are auto-detected by content type and returned inline.
- `selector` only works for HTML/XHTML. It does not work for JSON, PDF, images, or plain text.
- Large text fetches are stored in full but may use compact inline output to protect context size.

## Tool reference

### web_fetch

| Parameter | Description |
|-----------|-------------|
| `url` | URL to fetch |
| `format` | `markdown`, `text`, `html`, `json`, or `image` (default: markdown, or image for image responses) |
| `selector` | CSS selector for a specific page region (HTML only) |
| `timeout` | Request timeout in ms (default 10000) |
| `maxChars` | Character cap for text output |
| `refresh` | Bypass cache (default false) |

### get_web_content

| Parameter | Description |
|-----------|-------------|
| `responseId` | Stored response ID from a prior `web_search` or `web_fetch` |
| `offset` | Line offset to start from (1-indexed, default 1) |
| `limit` | Max lines to return (default 200, max 1000) |
| `maxChars` | Character cap for output |

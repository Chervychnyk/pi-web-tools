---
name: web-fetch
description: Use the web_fetch tool to retrieve a URL and extract readable markdown, text, html, json, or image content.
---

# web-fetch

Use the `web_fetch` extension tool when you need to read the contents of a URL.

## Preferred tool

- `web_fetch`
  - `url` — URL to fetch
  - `format` — `markdown`, `text`, `html`, `json`, or `image`
  - `selector` — optional CSS selector for a specific part of the page
  - `timeout` — optional request timeout in milliseconds
  - `maxChars` — optional character cap for text output
  - `refresh` — bypass cached fetch results and force a fresh request
- `get_web_content`
  - `responseId` — retrieve stored full content from a prior `web_search` or `web_fetch`
  - `offset` / `limit` — page through long stored content

## Guidance

- Prefer `markdown` for readable article/page content.
- Use `text` for plain extraction, `html` for raw markup, and `json` for API responses.
- GitHub repository URLs are handled specially: root URLs return repo summary/README/tree, `tree` URLs return directory listings, and `blob` URLs return file content when text-readable.
- PDF URLs are handled specially for `markdown` and `text` output via `pdftotext`.
- JS-heavy or blocked pages may fall back through Jina Reader automatically for markdown/text extraction.
- Use `selector` when the user wants a specific page region such as `article`, `main`, or `#content`.
- `selector` works only for HTML/XHTML responses; do not use it for JSON, PDF, images, or plain text URLs.
- Pair with `web_search` when you need to discover the right URL first.
- When `web_fetch` returns a `responseId`, use `get_web_content` to page back the full stored result without refetching the URL.

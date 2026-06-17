import type { FetchProgressHandler } from './types.ts'

// Each call replaces the prior partial result in the renderer (pi-coding-agent
// updateResult semantics). Use a compact `stage: message` shape so the partial
// renderer can show it as a one-liner without further parsing.
export function emitFetchProgress(
  onUpdate: FetchProgressHandler | undefined,
  stage: string,
  message: string,
) {
  onUpdate?.({
    content: [{ type: 'text', text: `${stage}: ${message}` }],
  })
}

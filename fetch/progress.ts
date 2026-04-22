import type { FetchProgressHandler } from './types.ts'

export function emitFetchProgress(
  onUpdate: FetchProgressHandler | undefined,
  stage: string,
  message: string,
) {
  onUpdate?.({
    content: [{ type: 'text', text: `[${stage}] ${message}` }],
  })
}

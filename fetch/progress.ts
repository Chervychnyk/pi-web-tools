import type { FetchProgressHandler } from './types.ts'

export type FetchProgress = {
  emit(stage: string, message: string): void
  // Pass-through for external fetchers (networkFetcher, jinaFetcher,
  // githubFetcher) that have their own onUpdate-shaped callback. These
  // emit content-only progress; the partial-render code falls back to
  // showing their text without the elapsed-time decoration.
  onUpdate: FetchProgressHandler | undefined
  // Read-only access to the wall-clock start. Useful when assembling a
  // final result that wants total elapsed time.
  startedAtMs(): number
}

// Stateful emitter scoped to a single tool invocation. Captures the start
// time once and stamps every emit with elapsedMs + the current phase, so
// renderResult on isPartial can show a live "⋯ phase · 120ms" status line.
export function createFetchProgress(
  onUpdate: FetchProgressHandler | undefined,
  options: { url: string },
): FetchProgress {
  const startedAt = Date.now()
  return {
    onUpdate,
    startedAtMs: () => startedAt,
    emit(stage, message) {
      const elapsedMs = Date.now() - startedAt
      onUpdate?.({
        content: [{ type: 'text', text: `${stage}: ${message}` }],
        details: {
          url: options.url,
          phase: stage,
          elapsedMs,
        },
      })
    },
  }
}

// Backwards-compatible plain emitter for paths that don't have a progress
// object handy (e.g. ad-hoc emissions inside utility code). Sends content
// without partial-details — renderResult falls back to the text-only path.
export function emitFetchProgress(
  onUpdate: FetchProgressHandler | undefined,
  stage: string,
  message: string,
) {
  onUpdate?.({
    content: [{ type: 'text', text: `${stage}: ${message}` }],
  })
}

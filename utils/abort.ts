export const DEFAULT_TIMEOUT = 10_000

export function createAbortController(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController()
  let timedOut = false

  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  return {
    controller,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
    },
    rethrowIfAbort: (error: unknown, label: string) => {
      if ((error as Error).name === 'AbortError') {
        if (timedOut) {
          throw new Error(`${label} timed out after ${timeoutMs}ms`)
        }
        throw new Error(`${label} aborted`)
      }
      throw error
    },
  }
}

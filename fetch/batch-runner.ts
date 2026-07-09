import type {
  BatchFetchDetails,
  BatchFetchItemSummary,
  FetchDetails,
  ParsedFetchParams,
} from './types.ts'
import { mapUnknownError } from './errors.ts'

export type BatchFetchRequest = Pick<
  ParsedFetchParams,
  | 'url'
  | 'requestedFormat'
  | 'selector'
  | 'headers'
  | 'proxy'
  | 'timeoutMs'
  | 'maxChars'
  | 'refresh'
>

function statusToProgress(status: BatchFetchItemSummary['status']) {
  switch (status) {
    case 'queued':
      return 0
    case 'running':
      return 0.55
    case 'done':
      return 1
    case 'error':
      return 1
    default:
      return 0
  }
}

export function buildBatchSummaryText(details: BatchFetchDetails) {
  const lines = [
    `Batch web fetch: ${details.completed}/${details.total} complete · ${details.succeeded} succeeded · ${details.failed} failed · concurrency ${details.concurrency}`,
  ]

  for (const item of details.items) {
    if (item.status === 'done') {
      const responseId = item.responseId ? ` responseId=${item.responseId}` : ''
      const statusCode = item.statusCode ? ` HTTP ${item.statusCode}` : ''
      lines.push(`${item.index + 1}. ✓ ${item.url}${statusCode}${responseId}`)
      continue
    }

    if (item.status === 'error') {
      const errorTag = item.errorCode
        ? ` [${item.errorCode}/${item.errorPhase || 'unknown'}]`
        : ''
      lines.push(
        `${item.index + 1}. ✗ ${item.url}${errorTag} — ${item.error || 'Unknown error'}`,
      )
      continue
    }

    lines.push(`${item.index + 1}. … ${item.url} — ${item.status}`)
  }

  return lines.join('\n')
}

export async function runFetchBatch(options: {
  requests: BatchFetchRequest[]
  concurrency: number
  fetchOne: (index: number, request: BatchFetchRequest) => Promise<{ details?: unknown }>
  onUpdate?: (update: { content: Array<{ type: 'text'; text: string }>; details: BatchFetchDetails }) => void
}) {
  const { requests, concurrency, fetchOne, onUpdate } = options
  const items: BatchFetchItemSummary[] = requests.map((request, index) => ({
    index,
    url: request.url,
    status: 'queued',
    progress: statusToProgress('queued'),
  }))

  let completed = 0
  let succeeded = 0
  let failed = 0

  const snapshot = (): BatchFetchDetails => ({
    total: items.length,
    completed,
    succeeded,
    failed,
    concurrency,
    items: items.map((item) => ({ ...item })),
  })

  const emitUpdate = () => {
    const details = snapshot()
    onUpdate?.({
      content: [{ type: 'text', text: buildBatchSummaryText(details) }],
      details,
    })
  }

  emitUpdate()

  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= requests.length) return

      const request = requests[index]!
      items[index] = {
        ...items[index]!,
        status: 'running',
        progress: statusToProgress('running'),
      }
      emitUpdate()

      try {
        const result = await fetchOne(index, request)
        const details = (result.details || {}) as FetchDetails
        items[index] = {
          ...items[index]!,
          status: 'done',
          progress: statusToProgress('done'),
          title: details.title,
          format: details.format,
          responseId: details.responseId,
          statusCode: details.status,
        }
        completed += 1
        succeeded += 1
      } catch (error) {
        const mapped = mapUnknownError(error, request.url)
        items[index] = {
          ...items[index]!,
          status: 'error',
          progress: statusToProgress('error'),
          error: mapped.message,
          errorCode: mapped.meta.code,
          errorPhase: mapped.meta.phase,
          retryable: mapped.meta.retryable,
        }
        completed += 1
        failed += 1
      }

      emitUpdate()
    }
  }

  await Promise.all(Array.from({ length: concurrency }, async () => worker()))
  return snapshot()
}

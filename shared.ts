import { execFile } from 'node:child_process'

export function normalizeHostname(hostname: string) {
  return hostname.trim().replace(/\.+$/g, '').toLowerCase()
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ *\n */g, '\n')
    .trim()
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function appendStoredResponseNote(
  content: string,
  responseId?: string,
  toolName = 'get_web_content',
  context?: { source?: string; label?: string },
) {
  if (!responseId) return content

  const lines = [`responseId: ${responseId}`]
  if (context?.source) lines.push(`${context.label || 'Source'}: ${context.source}`)
  lines.push(`Retrieve: ${toolName}({ responseId: ${JSON.stringify(responseId)} })`)

  return [content, '---', lines.join('\n')].join('\n\n')
}

export function execFileAsync(
  command: string,
  args: string[],
  signal?: AbortSignal,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            stderr?.trim() || stdout?.trim() || error.message || `Failed to run ${command}`,
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })

    if (!signal) return
    const onAbort = () => child.kill('SIGTERM')
    if (signal.aborted) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('exit', () => signal.removeEventListener('abort', onAbort))
  })
}

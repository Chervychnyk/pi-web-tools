import path from 'node:path'

export const MAX_TREE_ENTRIES = 200
export const MAX_INLINE_FILE_CHARS = 200_000

export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.jar',
  '.class',
  '.pyc',
  '.sqlite',
  '.db',
  '.dmg',
  '.exe',
  '.bin',
])

export function isProbablyBinaryPath(filePath: string) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function isProbablyBinaryBuffer(buffer: Buffer, sampleSize = 1024) {
  const limit = Math.min(sampleSize, buffer.byteLength)
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

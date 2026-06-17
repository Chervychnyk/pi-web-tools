const TOOL_CACHE = new Map<
  string,
  { value: unknown; storedAt: number; expiresAt: number }
>()

const MAX_CACHE_ENTRIES = 200
let lastPruneAt = 0

function pruneExpiredCacheEntries(now = Date.now()) {
  if (now - lastPruneAt < 1_000 && TOOL_CACHE.size <= MAX_CACHE_ENTRIES) return
  lastPruneAt = now

  for (const [key, entry] of TOOL_CACHE.entries()) {
    if (entry.expiresAt <= now) TOOL_CACHE.delete(key)
  }

  if (TOOL_CACHE.size > MAX_CACHE_ENTRIES) {
    const entries = [...TOOL_CACHE.entries()].sort(
      (a, b) => a[1].storedAt - b[1].storedAt,
    )
    const excess = entries.length - MAX_CACHE_ENTRIES
    for (let i = 0; i < excess; i++) {
      TOOL_CACHE.delete(entries[i]![0])
    }
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  )
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
    .join(',')}}`
}

export function buildCacheKey(parts: unknown) {
  return stableSerialize(parts)
}

export function getCachedValue<T>(key: string, now = Date.now()) {
  pruneExpiredCacheEntries(now)
  const entry = TOOL_CACHE.get(key)
  if (!entry || entry.expiresAt <= now) return undefined
  return {
    value: structuredClone(entry.value) as T,
    ageMs: Math.max(0, now - entry.storedAt),
  }
}

export function setCachedValue<T>(key: string, value: T, ttlMs: number, now = Date.now()) {
  pruneExpiredCacheEntries(now)
  TOOL_CACHE.set(key, {
    value: structuredClone(value),
    storedAt: now,
    expiresAt: now + ttlMs,
  })
}

// Test-only escape hatch — clears the in-memory cache so test isolation isn't
// hostage to module-load ordering. Safe to call from production code if you
// genuinely want a cache reset; it's just narrowly useful outside of tests.
export function clearToolCache() {
  TOOL_CACHE.clear()
}

export interface CacheEntry<T = unknown> {
  value: T
  expiresAt: number
}

export interface CacheOptions {
  ttl?: number
}

export interface ICacheClient {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, options?: CacheOptions): Promise<void>
  invalidate(key: string): Promise<void>
  invalidatePattern(pattern: string): Promise<void>
  clear(): Promise<void>
  getTtl(key: string): Promise<number | null>
}

export function matchesPattern(key: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return key.startsWith(pattern.slice(0, -1))
  }
  return key === pattern
}
export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

export interface CacheOptions {
  ttl?: number;
}

export interface ICacheClient {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T, options?: CacheOptions): void;
  invalidate(key: string): void;
  invalidatePattern(pattern: string): void;
  clear(): void;
}

export function matchesPattern(key: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return key.startsWith(pattern.slice(0, -1));
  }
  return key === pattern;
}

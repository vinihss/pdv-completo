export { MemoryCache } from "./memory-cache.js";
export { ICacheClient, CacheEntry, CacheOptions } from "./cache-client.js";

import { MemoryCache } from "./memory-cache.js";
import { ICacheClient } from "./cache-client.js";

let instance: ICacheClient | null = null;

export function getCache(): ICacheClient {
  if (!instance) {
    instance = new MemoryCache();
  }
  return instance;
}

export function resetCache(): void {
  if (instance) {
    instance.clear();
  }
  instance = null;
}

import type { TenantContext } from "./tenant-context.js";

export interface CachePort {
  get<T>(tenant: TenantContext, key: string): Promise<T | null>;
  set<T>(tenant: TenantContext, key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(tenant: TenantContext, key: string): Promise<void>;
  invalidatePrefix(tenant: TenantContext, prefix: string): Promise<void>;
}

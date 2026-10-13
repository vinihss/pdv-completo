/** Control-plane global: não é um repository tenant-scoped e não usa fallback de tenant. */
export interface TenantRecord { tenantId: string; slug: string; active: boolean }
export interface TenantRegistryPort {
  findBySlug(slug: string): Promise<TenantRecord | null>;
  findById(tenantId: string): Promise<TenantRecord | null>;
  listActive(): Promise<TenantRecord[]>;
}

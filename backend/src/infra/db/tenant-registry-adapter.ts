import type {
  TenantRegistry,
  TenantRegistryRecord,
} from "../../application/ports/effects.js";
import { findTenantByCustomDomain, findTenantBySlug } from "../tenant/registry.js";

/**
 * Adapter do port `TenantRegistry` (ports/effects.ts).
 *
 * Ponte de tipagem pura sobre `infra/tenant/registry.ts`: as queries SQL cruas
 * contra `public.tenant` e o cache (MemoryCache com TTL de 60s) continuam lá —
 * aqui só se traduz o `TenantRecord` para o record do port. O record do port é
 * ESTRUTURALMENTE igual ao `TenantRecord`, então o adapter não remonta campo.
 */
export class TenantRegistryAdapter implements TenantRegistry {
  async findBySlug(slug: string): Promise<TenantRegistryRecord | null> {
    return findTenantBySlug(slug);
  }

  async findByCustomDomain(host: string): Promise<TenantRegistryRecord | null> {
    return findTenantByCustomDomain(host);
  }
}

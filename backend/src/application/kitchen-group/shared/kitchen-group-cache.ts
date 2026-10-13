/**
 * Invalidação de cache do módulo de grupos de produção.
 */
import type { TenantCache } from "../../ports/effects.js";

/** Invalida o cache de grupos e de produtos (grupo afeta o lançamento). */
export async function invalidateKitchenGroupRelated(cache: TenantCache): Promise<void> {
  await cache.invalidatePrefix("kitchen-groups:");
  await cache.invalidatePrefix("products:");
}

/**
 * Invalidação de cache do módulo de categorias.
 */
import type { TenantCache } from "../../ports/effects.js";

/**
 * Invalida o cache de catálogo. O `:*` vira o prefixo do port
 * (`invalidatePrefix` acrescenta o `*`), e `public-menu` é uma chave
 * fixa — a invalidação por prefixo é um superset seguro (nenhuma outra
 * chave começa com `public-menu`).
 */
export async function invalidateCategoryRelated(cache: TenantCache): Promise<void> {
  await cache.invalidatePrefix("categories:");
  await cache.invalidatePrefix("products:");
  await cache.invalidatePrefix("public-menu");
}

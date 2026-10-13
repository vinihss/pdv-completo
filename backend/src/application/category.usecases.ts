/**
 * Catálogo — categorias. ONDA 3A da refatoração arquitetural.
 *
 * Factory pura (`createCategoryUsecases`): nenhuma importação de
 * infra/Drizzle. Persistência via `session.catalog`, audit via
 * `session.audit` (MESMA transação da escrita de domínio) e cache
 * via port `TenantCache` (efeito pós-escrita, não transacional).
 *
 * Semântica preservada do módulo original:
 *   - `listCategoriesUsecase`: cache `categories:*` (TTL 300s) →
 *     `session.catalog.listCategories()` (ordem de exibição);
 *   - create/update/delete: 404 prévio (`findCategoryById`), escrita,
 *     audit e invalidação de `categories:*`/`products:*`/`public-menu`;
 *   - delete é EXCLUSÃO REAL (§7.5): produtos vinculados ficam com
 *     `category_id = null` até reatribuição (regra do adapter).
 */
import type { TenantUnitOfWork } from "./ports/unit-of-work.js";
import type { TenantContext } from "./ports/tenant-context.js";
import type { TenantCache } from "./ports/effects.js";
import type { CategoryRecord } from "./ports/repositories.js";
import { Errors } from "../domain/errors.js";

export interface CategoryUsecasesDeps {
  uow: TenantUnitOfWork;
  cache: TenantCache;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

/**
 * Invalida o cache de catálogo. O `:*` vira o prefixo do port
 * (`invalidatePrefix` acrescenta o `*`), e `public-menu` é uma chave
 * fixa — a invalidação por prefixo é um superset seguro (nenhuma outra
 * chave começa com `public-menu`).
 */
async function invalidateCategoryRelated(cache: TenantCache): Promise<void> {
  await cache.invalidatePrefix("categories:");
  await cache.invalidatePrefix("products:");
  await cache.invalidatePrefix("public-menu");
}

export function createCategoryUsecases(deps: CategoryUsecasesDeps) {
  return {
    async listCategoriesUsecase(): Promise<CategoryRecord[]> {
      const cached = await deps.cache.get<CategoryRecord[]>("categories:*");
      if (cached) return cached;
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.catalog.listCategories();
        await deps.cache.set("categories:*", rows, { ttl: 300 });
        return rows;
      });
    },

    async createCategoryUsecase(
      input: { name: string; displayOrder?: number },
      actorId: string,
    ): Promise<CategoryRecord> {
      return deps.uow.run(deps.tenant(), async (session) => {
        const row = await session.catalog.createCategory(input);
        await session.audit.record({
          actorId,
          action: "category_created",
          details: { categoryId: row.id, name: row.name },
        });
        await invalidateCategoryRelated(deps.cache);
        return row;
      });
    },

    async updateCategoryUsecase(
      id: string,
      input: { name?: string; displayOrder?: number; active?: boolean },
      actorId: string,
    ): Promise<CategoryRecord> {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findCategoryById(id);
        if (!existing) throw Errors.notFound("Categoria");
        const row = await session.catalog.updateCategory(id, input);
        await session.audit.record({
          actorId,
          action: "category_updated",
          details: { categoryId: id, name: row.name },
        });
        await invalidateCategoryRelated(deps.cache);
        return row;
      });
    },

    async deleteCategoryUsecase(id: string, actorId: string): Promise<void> {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findCategoryById(id);
        if (!existing) throw Errors.notFound("Categoria");
        await session.catalog.deleteCategory(id);
        await session.audit.record({
          actorId,
          action: "category_deleted",
          details: { categoryId: id, name: existing.name },
        });
        await invalidateCategoryRelated(deps.cache);
      });
    },
  };
}

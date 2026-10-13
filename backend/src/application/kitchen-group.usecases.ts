/**
 * Catálogo — grupos de produção (estações da cozinha). ONDA 3A.
 *
 * Factory pura (`createKitchenGroupUsecases`): sem Drizzle/infra.
 * Persistência via `session.catalog`, audit via `session.audit`
 * (mesma transação) e cache via port `TenantCache`.
 *
 * Semântica preservada:
 *   - `listKitchenGroupsUsecase`: cache `kitchen-groups:*`
 *     (TTL 300s) → `session.catalog.listKitchenGroups()`;
 *   - create/update/delete: 404 prévio, escrita, audit e
 *     invalidação de `kitchen-groups:*`/`products:*`;
 *   - delete é EXCLUSÃO REAL: produtos vinculados ficam com
 *     `kitchen_group_id = null` (não vão mais para a cozinha)
 *     até reatribuição (regra do adapter).
 */
import type { TenantUnitOfWork } from "./ports/unit-of-work.js";
import type { TenantContext } from "./ports/tenant-context.js";
import type { TenantCache } from "./ports/effects.js";
import type { KitchenGroupRecord } from "./ports/repositories.js";
import { Errors } from "../domain/errors.js";

export interface KitchenGroupUsecasesDeps {
  uow: TenantUnitOfWork;
  cache: TenantCache;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

/** Invalida o cache de grupos e de produtos (grupo afeta o lançamento). */
async function invalidateKitchenGroupRelated(cache: TenantCache): Promise<void> {
  await cache.invalidatePrefix("kitchen-groups:");
  await cache.invalidatePrefix("products:");
}

export function createKitchenGroupUsecases(deps: KitchenGroupUsecasesDeps) {
  return {
    async listKitchenGroupsUsecase(): Promise<KitchenGroupRecord[]> {
      const cached = await deps.cache.get<KitchenGroupRecord[]>("kitchen-groups:*");
      if (cached) return cached;
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.catalog.listKitchenGroups();
        await deps.cache.set("kitchen-groups:*", rows, { ttl: 300 });
        return rows;
      });
    },

    async createKitchenGroupUsecase(
      input: { name: string; displayOrder?: number },
      actorId: string,
    ): Promise<KitchenGroupRecord> {
      return deps.uow.run(deps.tenant(), async (session) => {
        const row = await session.catalog.createKitchenGroup(input);
        await session.audit.record({
          actorId,
          action: "kitchen_group_created",
          details: { kitchenGroupId: row.id, name: row.name },
        });
        await invalidateKitchenGroupRelated(deps.cache);
        return row;
      });
    },

    async updateKitchenGroupUsecase(
      id: string,
      input: { name?: string; displayOrder?: number; active?: boolean },
      actorId: string,
    ): Promise<KitchenGroupRecord> {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findKitchenGroupById(id);
        if (!existing) throw Errors.notFound("Grupo de produção");
        const row = await session.catalog.updateKitchenGroup(id, input);
        await session.audit.record({
          actorId,
          action: "kitchen_group_updated",
          details: { kitchenGroupId: id },
        });
        await invalidateKitchenGroupRelated(deps.cache);
        return row;
      });
    },

    async deleteKitchenGroupUsecase(id: string, actorId: string): Promise<void> {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findKitchenGroupById(id);
        if (!existing) throw Errors.notFound("Grupo de produção");
        await session.catalog.deleteKitchenGroup(id);
        await session.audit.record({
          actorId,
          action: "kitchen_group_deleted",
          details: { kitchenGroupId: id, name: existing.name },
        });
        await invalidateKitchenGroupRelated(deps.cache);
      });
    },
  };
}

/**
 * GET /kitchen-groups — grupos de produção em ordem de exibição.
 *
 * Cache `kitchen-groups:*` (TTL 300s) antes da transação; no miss, lê pelo port
 * `session.catalog` e reabastece o cache.
 */
import type { KitchenGroupRecord } from "../../ports/repositories.js";
import type { KitchenGroupDependencies } from "../ports/kitchen-group-dependencies.js";

export class ListKitchenGroupsUseCase {
  constructor(private readonly deps: KitchenGroupDependencies) {}

  async execute(): Promise<KitchenGroupRecord[]> {
    const cached = await this.deps.cache.get<KitchenGroupRecord[]>("kitchen-groups:*");
    if (cached) return cached;
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const rows = await session.catalog.listKitchenGroups();
      await this.deps.cache.set("kitchen-groups:*", rows, { ttl: 300 });
      return rows;
    });
  }
}

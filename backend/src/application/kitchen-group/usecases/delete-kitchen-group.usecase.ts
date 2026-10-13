/**
 * DELETE /kitchen-groups/:id — EXCLUSÃO REAL.
 *
 * Produtos vinculados ficam com `kitchen_group_id = null` (não vão mais para a
 * cozinha) até reatribuição (regra do adapter). Audit na MESMA transação e
 * invalidação do cache de grupos/produtos.
 */
import type { KitchenGroupDependencies } from "../ports/kitchen-group-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { invalidateKitchenGroupRelated } from "../shared/kitchen-group-cache.js";

export class DeleteKitchenGroupUseCase {
  constructor(private readonly deps: KitchenGroupDependencies) {}

  async execute(id: string, actorId: string): Promise<void> {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findKitchenGroupById(id);
      if (!existing) throw Errors.notFound("Grupo de produção");
      await session.catalog.deleteKitchenGroup(id);
      await session.audit.record({
        actorId,
        action: "kitchen_group_deleted",
        details: { kitchenGroupId: id, name: existing.name },
      });
      await invalidateKitchenGroupRelated(this.deps.cache);
    });
  }
}

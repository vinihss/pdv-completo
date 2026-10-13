/**
 * PATCH /kitchen-groups/:id — update parcial de grupo de produção.
 *
 * 404 prévio (`findKitchenGroupById`), escrita, audit na MESMA transação e
 * invalidação do cache de grupos/produtos.
 */
import type { KitchenGroupRecord } from "../../ports/repositories.js";
import type { KitchenGroupDependencies } from "../ports/kitchen-group-dependencies.js";
import { Errors } from "../../../domain/errors.js";
import { invalidateKitchenGroupRelated } from "../shared/kitchen-group-cache.js";

export type UpdateKitchenGroupInput = {
  name?: string;
  displayOrder?: number;
  active?: boolean;
};

export class UpdateKitchenGroupUseCase {
  constructor(private readonly deps: KitchenGroupDependencies) {}

  async execute(id: string, input: UpdateKitchenGroupInput, actorId: string): Promise<KitchenGroupRecord> {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.catalog.findKitchenGroupById(id);
      if (!existing) throw Errors.notFound("Grupo de produção");
      const row = await session.catalog.updateKitchenGroup(id, input);
      await session.audit.record({
        actorId,
        action: "kitchen_group_updated",
        details: { kitchenGroupId: id },
      });
      await invalidateKitchenGroupRelated(this.deps.cache);
      return row;
    });
  }
}

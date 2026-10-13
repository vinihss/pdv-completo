/**
 * POST /kitchen-groups — cria grupo de produção (estação da cozinha).
 *
 * Escrita via `session.catalog`, audit na MESMA transação e invalidação do
 * cache de grupos/produtos.
 */
import type { KitchenGroupRecord } from "../../ports/repositories.js";
import type { KitchenGroupDependencies } from "../ports/kitchen-group-dependencies.js";
import { invalidateKitchenGroupRelated } from "../shared/kitchen-group-cache.js";

export type CreateKitchenGroupInput = {
  name: string;
  displayOrder?: number;
};

export class CreateKitchenGroupUseCase {
  constructor(private readonly deps: KitchenGroupDependencies) {}

  async execute(input: CreateKitchenGroupInput, actorId: string): Promise<KitchenGroupRecord> {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const row = await session.catalog.createKitchenGroup(input);
      await session.audit.record({
        actorId,
        action: "kitchen_group_created",
        details: { kitchenGroupId: row.id, name: row.name },
      });
      await invalidateKitchenGroupRelated(this.deps.cache);
      return row;
    });
  }
}

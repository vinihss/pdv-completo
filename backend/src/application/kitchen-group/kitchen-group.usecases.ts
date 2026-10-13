/**
 * Catálogo — grupos de produção (estações da cozinha). Ponto de entrada de
 * COMPATIBILIDADE.
 *
 * A implementação foi decomposta em um Use Case por operação (Command Pattern
 * / Single Use Case Class) em `usecases/*.usecase.ts`, com as dependências em
 * `ports/kitchen-group-dependencies.ts`, o helper de cache em
 * `shared/kitchen-group-cache.ts` e o facade `KitchenGroupModule` em
 * `kitchen-group.module.ts`.
 *
 * Este arquivo mantém a factory `createKitchenGroupUsecases` com os NOMES
 * LEGADOS (`listKitchenGroupsUsecase`, ...) para a composition root
 * (`infra/composition/default-usecases.ts`), que re-exporta para as rotas.
 * Nada muda na assinatura observada de fora. Para uso novo, prefira
 * `KitchenGroupModule` e `.listKitchenGroups.execute(...)`.
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
import { KitchenGroupModule } from "./kitchen-group.module.js";
import type { KitchenGroupDependencies } from "./ports/kitchen-group-dependencies.js";
import type { CreateKitchenGroupInput } from "./usecases/create-kitchen-group.usecase.js";
import type { UpdateKitchenGroupInput } from "./usecases/update-kitchen-group.usecase.js";

export { KitchenGroupModule };
export type { KitchenGroupDependencies };
export type { KitchenGroupUsecasesDeps } from "./ports/kitchen-group-dependencies.js";
export { ListKitchenGroupsUseCase } from "./usecases/list-kitchen-groups.usecase.js";
export {
  CreateKitchenGroupUseCase,
  type CreateKitchenGroupInput,
} from "./usecases/create-kitchen-group.usecase.js";
export {
  UpdateKitchenGroupUseCase,
  type UpdateKitchenGroupInput,
} from "./usecases/update-kitchen-group.usecase.js";
export { DeleteKitchenGroupUseCase } from "./usecases/delete-kitchen-group.usecase.js";

export function createKitchenGroupUsecases(deps: KitchenGroupDependencies) {
  const module = new KitchenGroupModule(deps);
  return {
    listKitchenGroupsUsecase: () => module.listKitchenGroups.execute(),
    createKitchenGroupUsecase: (input: CreateKitchenGroupInput, actorId: string) =>
      module.createKitchenGroup.execute(input, actorId),
    updateKitchenGroupUsecase: (id: string, input: UpdateKitchenGroupInput, actorId: string) =>
      module.updateKitchenGroup.execute(id, input, actorId),
    deleteKitchenGroupUsecase: (id: string, actorId: string) =>
      module.deleteKitchenGroup.execute(id, actorId),
  };
}

/**
 * Módulo de grupos de produção — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências (injetado
 * via construtor) e expõe as instâncias como propriedades readonly.
 */
import type { KitchenGroupDependencies } from "./ports/kitchen-group-dependencies.js";
import { ListKitchenGroupsUseCase } from "./usecases/list-kitchen-groups.usecase.js";
import { CreateKitchenGroupUseCase } from "./usecases/create-kitchen-group.usecase.js";
import { UpdateKitchenGroupUseCase } from "./usecases/update-kitchen-group.usecase.js";
import { DeleteKitchenGroupUseCase } from "./usecases/delete-kitchen-group.usecase.js";

export class KitchenGroupModule {
  public readonly listKitchenGroups: ListKitchenGroupsUseCase;
  public readonly createKitchenGroup: CreateKitchenGroupUseCase;
  public readonly updateKitchenGroup: UpdateKitchenGroupUseCase;
  public readonly deleteKitchenGroup: DeleteKitchenGroupUseCase;

  constructor(deps: KitchenGroupDependencies) {
    this.listKitchenGroups = new ListKitchenGroupsUseCase(deps);
    this.createKitchenGroup = new CreateKitchenGroupUseCase(deps);
    this.updateKitchenGroup = new UpdateKitchenGroupUseCase(deps);
    this.deleteKitchenGroup = new DeleteKitchenGroupUseCase(deps);
  }
}

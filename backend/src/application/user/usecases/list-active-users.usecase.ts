/**
 * `GET /auth/users` (público, tela de seleção do login): só ativos e
 * respeitando os toggles de rollout — esconde "kitchen" quando
 * kitchen_enabled=false e "courier" quando uses_delivery=false.
 */
import type { UserDependencies } from "../ports/user-dependencies.js";
import { photoUrl } from "../shared/user-helpers.js";

export class ListActiveUsersUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute() {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const settings = await session.storeSettings.findSingleton();
      const rows = await session.users.listActive();
      return rows
        .filter((u) => settings?.kitchenEnabled || u.role !== "kitchen")
        .filter((u) => settings?.usesDelivery !== false || u.role !== "courier")
        .map((u) => ({ id: u.id, name: u.name, role: u.role, photoPath: photoUrl(u.photoPath, "user") }));
    });
  }
}

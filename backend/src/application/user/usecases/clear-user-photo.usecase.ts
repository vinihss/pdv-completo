/**
 * `DELETE /users/:id/photo` e `/auth/me/photo`.
 *
 * Remove o arquivo do disco, grava `photo_path = null` e o audit na MESMA
 * transação do UPDATE.
 */
import { Errors } from "../../../domain/errors.js";
import type { UserDependencies } from "../ports/user-dependencies.js";
import { serializeUser, storageFilename } from "../shared/user-helpers.js";

export class ClearUserPhotoUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(id: string, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.users.findById(id);
      if (!existing) throw Errors.notFound("Usuário");
      const previous = storageFilename(existing.photoPath);
      if (previous) await this.deps.storage.remove("user", previous);

      const updated = await session.users.save({ id, name: existing.name, role: existing.role, photoPath: null });
      await session.audit.record({
        actorId,
        action: "user_photo_removed",
        orderId: null,
        details: { userId: id },
      });
      return serializeUser(updated);
    });
  }
}

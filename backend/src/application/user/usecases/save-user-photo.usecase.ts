/**
 * `POST /users/:id/photo` e `/auth/me/photo`.
 *
 * Mesmo desenho das fotos de cliente/produto: nome de arquivo GERADO pelo app
 * a partir do id (o nome enviado pelo cliente nunca vira caminho em disco), o
 * nome gravado no banco é só o basename, arquivo antigo removido quando a
 * extensão muda, e o audit na mesma transação do UPDATE.
 */
import { Errors } from "../../../domain/errors.js";
import type { UserDependencies } from "../ports/user-dependencies.js";
import { isSafeFilename, serializeUser, storageFilename } from "../shared/user-helpers.js";

export type SaveUserPhotoInput = {
  buffer: Buffer;
  ext: string;
};

export class SaveUserPhotoUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(id: string, input: SaveUserPhotoInput, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.users.findById(id);
      if (!existing) throw Errors.notFound("Usuário");

      const filename = `${id}.${input.ext}`;
      if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "photo" });
      await this.deps.storage.put("user", filename, input.buffer);

      const previous = storageFilename(existing.photoPath);
      if (previous && previous !== filename) await this.deps.storage.remove("user", previous);

      const updated = await session.users.save({ id, name: existing.name, role: existing.role, photoPath: filename });
      await session.audit.record({
        actorId,
        action: "user_photo_changed",
        orderId: null,
        details: { userId: id },
      });
      return serializeUser(updated);
    });
  }
}

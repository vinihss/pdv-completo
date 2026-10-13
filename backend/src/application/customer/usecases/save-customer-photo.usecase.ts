/**
 * `POST /customers/:id/photo` — upload da foto do cliente.
 *
 * Cópia do desenho de `user/` (foto de equipe), que é o mesmo das fotos de
 * produto e do logo da loja: nome de arquivo GERADO pelo app a partir do id
 * (o nome enviado pelo cliente nunca vira caminho em disco), o nome gravado no
 * banco é só o basename, arquivo antigo removido quando a extensão muda, e o
 * audit na mesma transação do UPDATE.
 */
import { Errors } from "../../../domain/errors.js";
import type { CustomerDependencies } from "../ports/customer-dependencies.js";
import { isSafeFilename, serializeCustomer, storageFilename } from "../shared/customer-helpers.js";

export type SaveCustomerPhotoInput = {
  buffer: Buffer;
  ext: string;
};

export class SaveCustomerPhotoUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(id: string, input: SaveCustomerPhotoInput, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.customers.findById(id);
      if (!existing) throw Errors.notFound("Cliente");

      const filename = `${id}.${input.ext}`;
      if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "photo" });
      await this.deps.storage.put("customer", filename, input.buffer);

      // Remove a foto antiga quando o cliente trocou a extensão do arquivo
      const previous = storageFilename(existing.photoPath);
      if (previous && previous !== filename) await this.deps.storage.remove("customer", previous);

      const updated = await session.customers.save({ id, name: existing.name, photoPath: filename });
      await session.audit.record({
        actorId,
        action: "customer_photo_changed",
        orderId: null,
        details: { customerId: id },
      });
      return serializeCustomer(updated);
    });
  }
}

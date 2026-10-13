/**
 * `DELETE /customers/:id/photo` — remove a foto do disco e limpa `photo_path`,
 * com audit na MESMA transação do UPDATE.
 */
import { Errors } from "../../../domain/errors.js";
import type { CustomerDependencies } from "../ports/customer-dependencies.js";
import { serializeCustomer, storageFilename } from "../shared/customer-helpers.js";

export class ClearCustomerPhotoUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(id: string, actorId: string) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.customers.findById(id);
      if (!existing) throw Errors.notFound("Cliente");
      const previous = storageFilename(existing.photoPath);
      if (previous) await this.deps.storage.remove("customer", previous);

      const updated = await session.customers.save({ id, name: existing.name, photoPath: null });
      await session.audit.record({
        actorId,
        action: "customer_photo_removed",
        orderId: null,
        details: { customerId: id },
      });
      return serializeCustomer(updated);
    });
  }
}

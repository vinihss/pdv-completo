/**
 * `PATCH /customers/:id` — update parcial (soft-delete via `active=false`).
 *
 * Unicidade de email/CPF com 400, audit na MESMA transação. Ação de audit
 * distingue desativação/reativação da edição comum.
 */
import { Errors } from "../../../domain/errors.js";
import { normalizeCpf } from "../../../domain/cpf.js";
import type { CustomerDependencies } from "../ports/customer-dependencies.js";
import {
  assertCpfAvailable,
  assertEmailAvailable,
  normalizeEmail,
  normalizeNotes,
  normalizePhone,
  serializeCustomer,
} from "../shared/customer-helpers.js";

export type UpdateCustomerInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  cpf?: string | null;
  notes?: string | null;
  active?: boolean;
};

export class UpdateCustomerUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(id: string, input: UpdateCustomerInput, actorId: string) {
    const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
    const cpf = input.cpf !== undefined ? normalizeCpf(input.cpf) : undefined;
    const phone = input.phone !== undefined ? normalizePhone(input.phone) : undefined;
    const notes = input.notes !== undefined ? normalizeNotes(input.notes) : undefined;

    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.customers.findById(id);
      if (!existing) throw Errors.notFound("Cliente");

      if (input.email !== undefined) await assertEmailAvailable(session, email, id);
      if (input.cpf !== undefined) await assertCpfAvailable(session, cpf, id);

      const updated = await session.customers.save({
        id,
        name: existing.name,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(cpf !== undefined ? { cpf } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      });
      await session.audit.record({
        actorId,
        action:
          input.active === false
            ? "customer_deactivated"
            : input.active === true
              ? "customer_reactivated"
              : "customer_updated",
        orderId: null,
        details: { customerId: id, name: updated.name },
      });
      return serializeCustomer(updated);
    });
  }
}

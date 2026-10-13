/**
 * `POST /customers` — cria cliente.
 *
 * Unicidade de email/CPF com 400 (o `uq_customer_email`/`uq_customer_cpf` do
 * banco é a segunda linha de defesa), normalizações de domínio e audit na
 * MESMA transação.
 */
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

export type CreateCustomerInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  cpf?: string | null;
  notes?: string | null;
};

export class CreateCustomerUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(input: CreateCustomerInput, actorId: string) {
    const email = normalizeEmail(input.email);
    const cpf = normalizeCpf(input.cpf);
    const phone = normalizePhone(input.phone);
    const notes = normalizeNotes(input.notes);

    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      await assertEmailAvailable(session, email);
      await assertCpfAvailable(session, cpf);
      const created = await session.customers.save({ name: input.name, phone, email, cpf, notes });
      await session.audit.record({
        actorId,
        action: "customer_created",
        orderId: null,
        details: { customerId: created.id, name: created.name },
      });
      return serializeCustomer(created);
    });
  }
}

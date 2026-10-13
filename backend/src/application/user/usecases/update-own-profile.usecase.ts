/**
 * Self-service de perfil (PATCH /auth/me): o usuário logado atualiza os
 * PRÓPRIOS dados de contato — `name`, `phone` e `email`.
 *
 * O id vem do token, nunca do body, e o conjunto de campos é fechado por
 * construção — `role`, `active` e `pin` nem entram na assinatura. Audit log
 * na MESMA transação do UPDATE.
 */
import { Errors } from "../../../domain/errors.js";
import type { UserDependencies } from "../ports/user-dependencies.js";
import { assertEmailAvailable, normalizeEmail, normalizePhone, serializeUser } from "../shared/user-helpers.js";

export type UpdateOwnProfileInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
};

export class UpdateOwnProfileUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(id: string, input: UpdateOwnProfileInput) {
    const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
    const phoneDigits = input.phone !== undefined ? normalizePhone(input.phone) : undefined;

    const updated = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.users.findById(id);
      if (!existing) throw Errors.notFound("Usuário");
      if (input.email !== undefined) await assertEmailAvailable(session, email, id);

      const row = await session.users.save({
        id,
        name: input.name,
        role: existing.role,
        ...(phoneDigits !== undefined ? { phone: phoneDigits } : {}),
        ...(email !== undefined ? { email } : {}),
      });
      await session.audit.record({
        actorId: id,
        action: "user_profile_updated",
        orderId: null,
        details: {
          userId: id,
          fields: [
            "name",
            ...(phoneDigits !== undefined ? ["phone"] : []),
            ...(email !== undefined ? ["email"] : []),
          ],
        },
      });
      return row;
    });
    return serializeUser(updated);
  }
}

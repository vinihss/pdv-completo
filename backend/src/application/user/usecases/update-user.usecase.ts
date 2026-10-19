/**
 * `PATCH /users/:id` (manager): update parcial + cascata de desativação.
 */
import argon2 from "argon2";
import { Errors } from "../../../domain/errors.js";
import type { UserDependencies } from "../ports/user-dependencies.js";
import {
  assertEmailAvailable,
  normalizeEmail,
  normalizePhone,
  serializeUser,
  type UserRole,
} from "../shared/user-helpers.js";
import { newId, nowIso } from "../../identity/identity-helpers.js";

export type UpdateUserInput = {
  name?: string;
  role?: UserRole;
  active?: boolean;
  phone?: string | null;
  email?: string | null;
  pin?: string;
};

export class UpdateUserUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(id: string, input: UpdateUserInput, actorId?: string) {
    const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
    const phoneDigits = input.phone !== undefined ? normalizePhone(input.phone) : undefined;

    // PIN manual (4-6 dígitos): mesma regra do reset-pin — troca o hash e
    // desbloqueia a conta. O reset-pin continua existindo para gerar um PIN
    // aleatório.
    let pinHash: string | undefined;
    if (input.pin !== undefined) {
      const digits = input.pin.replace(/\D/g, "");
      if (digits.length < 4 || digits.length > 6) throw Errors.validationFailed({ field: "pin" });
      pinHash = await argon2.hash(digits);
    }

    const updated = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.users.findById(id);
      if (!existing) throw Errors.notFound("Usuário");
      if (input.email !== undefined) await assertEmailAvailable(session, email, id);

      // ADIÇÃO (Onda identidade — docs/26 §4): email informado VINCULA a conta
      // global (encontrada ou criada DORMANT, sem senha — quem define credencial
      // é o convite). Email apagado (`null`) DESVINCULA. Aqui NÃO se envia email
      // nenhum: `PATCH /users/:id` só liga/desliga o vínculo.
      let accountId: string | null | undefined;
      if (input.email !== undefined) {
        if (!email) {
          accountId = null;
        } else {
          const account = await session.identity.ensureAccount({
            id: newId(),
            email,
            name: input.name ?? existing.name,
            now: nowIso(),
          });
          accountId = account.id;
        }
      }

      // Desativar usuário é a lacuna fechada do docs/21 §5.4: além do login
      // negar, os aparelhos provisionados do usuário são revogados NA MESMA
      // transação (+ audit + evento pro gerente) e o cache de sessão aberta do
      // middleware é invalidado. Reativar NÃO devolve aparelhos (decisão do
      // plano — exige novo provisionamento).
      const deactivating = input.active === false && existing.active === true;

      const row = await session.users.save({
        id,
        name: input.name ?? existing.name,
        role: input.role ?? existing.role,
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(phoneDigits !== undefined ? { phone: phoneDigits } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(pinHash !== undefined ? { pinHash } : {}),
      });

      if (deactivating) {
        const revokedDevices = await session.userDevices.revokeAll(id, new Date().toISOString());
        await session.audit.record({
          actorId: actorId ?? id,
          action: "user_access_toggled",
          orderId: null,
          details: { userId: id, active: false, revokedDevices },
        });
        await session.outbox.enqueue({
          room: "alerts:manager",
          type: "user_access_changed",
          aggregateId: id,
          payload: { userId: id, active: false, revokedDevices },
        });
        // Sessões JWT abertas caem na próxima requisição (não espera os 30s do cache).
        this.deps.invalidateActiveUser(id);
      }
      return row;
    });
    return serializeUser(updated);
  }
}

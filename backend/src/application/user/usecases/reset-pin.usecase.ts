/**
 * `PATCH /users/:id/reset-pin` (manager): PIN aleatório, retornado uma vez.
 */
import argon2 from "argon2";
import { Errors } from "../../../domain/errors.js";
import type { UserDependencies } from "../ports/user-dependencies.js";
import { randomPin } from "../shared/user-helpers.js";

export class ResetPinUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(id: string) {
    const pin = randomPin();
    const pinHash = await argon2.hash(pin);
    await this.deps.uow.run(this.deps.tenant(), async (session) => {
      const existing = await session.users.findById(id);
      if (!existing) throw Errors.notFound("Usuário");
      await session.users.save({ id, name: existing.name, role: existing.role, pinHash });
    });
    return { pin };
  }
}

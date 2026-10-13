/**
 * `POST /users` (manager): cria com PIN aleatório (retornado uma única vez).
 */
import argon2 from "argon2";
import type { UserDependencies } from "../ports/user-dependencies.js";
import {
  assertEmailAvailable,
  normalizeEmail,
  normalizePhone,
  randomPin,
  serializeUser,
  type UserRole,
} from "../shared/user-helpers.js";

export type CreateUserInput = {
  name: string;
  role: UserRole;
  phone?: string | null;
  email?: string | null;
};

export class CreateUserUseCase {
  constructor(private readonly deps: UserDependencies) {}

  async execute(input: CreateUserInput) {
    const email = normalizeEmail(input.email);
    const phoneDigits = normalizePhone(input.phone);
    const pin = randomPin();
    const pinHash = await argon2.hash(pin);
    const created = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      await assertEmailAvailable(session, email);
      return session.users.save({ name: input.name, role: input.role, pinHash, phone: phoneDigits, email });
    });
    return { ...serializeUser(created), pin }; // PIN em texto puro, uma única vez, pra exibição ao gerente
  }
}

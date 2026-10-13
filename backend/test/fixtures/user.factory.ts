import { db } from "../../src/infra/db/client.js";
import { users } from "../../src/infra/db/schema.js";
import { tokenOf } from "../helpers.js";

type InsertUser = typeof users.$inferInsert;
type SelectUser = typeof users.$inferSelect;

export interface TestUser extends SelectUser {
  token: string;
}

export async function createUser(overrides: Partial<InsertUser> = {}): Promise<TestUser> {
  const id = overrides.id ?? `u-${crypto.randomUUID()}`;
  const role = overrides.role ?? "waiter";
  const user: InsertUser = {
    id,
    name: overrides.name ?? `Usuário ${role.toUpperCase()} ${id.slice(-4)}`,
    role,
    pinHash: overrides.pinHash ?? "x",
    active: overrides.active ?? true,
    failedAttempts: overrides.failedAttempts ?? 0,
    phone: overrides.phone,
    email: overrides.email,
    photoPath: overrides.photoPath,
    ...overrides,
  };

  await db
    .insert(users)
    .values(user)
    .onConflictDoUpdate({
      target: users.id,
      set: user,
    });

  const token = tokenOf(id, role);

  return {
    ...(user as SelectUser),
    token,
  };
}

export function createWaiter(overrides: Partial<InsertUser> = {}) {
  return createUser({ role: "waiter", name: "Garçom Teste", ...overrides });
}

export function createManager(overrides: Partial<InsertUser> = {}) {
  return createUser({ role: "manager", name: "Gerente Teste", ...overrides });
}

export function createCashier(overrides: Partial<InsertUser> = {}) {
  return createUser({ role: "cashier", name: "Caixa Teste", ...overrides });
}

export function createKitchen(overrides: Partial<InsertUser> = {}) {
  return createUser({ role: "kitchen", name: "Cozinha Teste", ...overrides });
}

export function createCourier(overrides: Partial<InsertUser> = {}) {
  return createUser({ role: "courier", name: "Entregador Teste", ...overrides });
}

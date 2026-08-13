import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { db } from "../infra/db/client.js";
import { users } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";

function serialize(u: typeof users.$inferSelect) {
  return { id: u.id, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt };
}

export async function listUsersUsecase() {
  const rows = await db.query.users.findMany({ orderBy: (u, { asc }) => asc(u.name) });
  return rows.map(serialize);
}

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function createUserUsecase(input: { name: string; role: "waiter" | "kitchen" | "manager" }) {
  const pin = randomPin();
  const pinHash = await argon2.hash(pin);
  const [created] = await db.insert(users).values({ name: input.name, role: input.role, pinHash }).returning();
  return { ...serialize(created), pin }; // PIN retornado uma única vez, em texto puro, pra exibição ao gerente
}

export async function updateUserUsecase(
  id: string,
  input: { name?: string; role?: "waiter" | "kitchen" | "manager"; active?: boolean }
) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!existing) throw Errors.notFound("Usuário");
  const [updated] = await db
    .update(users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, id))
    .returning();
  return serialize(updated);
}

export async function resetPinUsecase(id: string) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!existing) throw Errors.notFound("Usuário");
  const pin = randomPin();
  const pinHash = await argon2.hash(pin);
  await db
    .update(users)
    .set({ pinHash, failedAttempts: 0, lockedUntil: null, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id));
  return { pin }; // exibido uma única vez ao gerente
}

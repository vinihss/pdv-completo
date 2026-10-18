import { eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { users } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import type { Id, UserRecord, UserRepository } from "../../../application/ports/repositories.js";

// =====================================================================
// Usuários
// =====================================================================

function toUserRecord(u: typeof users.$inferSelect): UserRecord {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    pinHash: u.pinHash,
    active: u.active,
    phone: u.phone,
    email: u.email,
    accountId: u.accountId,
    photoPath: u.photoPath,
    createdAt: u.createdAt,
    failedAttempts: u.failedAttempts,
    lockedUntil: u.lockedUntil,
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<UserRecord | null> {
    const row = await this.tx.query.users.findFirst({ where: eq(users.id, id) });
    return row ? toUserRecord(row) : null;
  }

  /** Id, telefone ou email (case-insensitive). PIN/lockout são do use case de login. */
  async findByLogin(login: string): Promise<UserRecord | null> {
    let row = await this.tx.query.users.findFirst({ where: eq(users.id, login) });
    if (!row) row = await this.tx.query.users.findFirst({ where: eq(users.phone, login) });
    if (!row) {
      row = await this.tx.query.users.findFirst({
        where: sql`lower(${users.email}) = lower(${login})`,
      });
    }
    return row ? toUserRecord(row) : null;
  }

  async listActive(): Promise<Array<Pick<UserRecord, "id" | "name" | "role" | "photoPath">>> {
    const rows = await this.tx.query.users.findMany({
      where: eq(users.active, true),
      orderBy: (u, { asc: asc_ }) => asc_(u.name),
    });
    return rows.map((u) => ({ id: u.id, name: u.name, role: u.role, photoPath: u.photoPath }));
  }

  /** ADIÇÃO (Onda auth): lista completa em ordem alfabética (`GET /users`). */
  async list(): Promise<UserRecord[]> {
    const rows = await this.tx.query.users.findMany({
      orderBy: (u, { asc: asc_ }) => asc_(u.name),
    });
    return rows.map(toUserRecord);
  }

  /** ADIÇÃO (Onda auth): usuário por email EXATO (unicidade validada no use case). */
  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.tx.query.users.findFirst({ where: eq(users.email, email) });
    return row ? toUserRecord(row) : null;
  }

  /**
   * ADIÇÃO (Onda auth): grava o estado de tentativas de login. Mesma coluna do
   * original (`failedAttempts`/`lockedUntil`), sem mexer em `updatedAt` — a
   * régua de `countFailedAttempt`/reset do `login.usecase` é preservada.
   */
  async setLoginState(id: Id, state: { failedAttempts: number; lockedUntil: string | null }): Promise<void> {
    await this.tx
      .update(users)
      .set({ failedAttempts: state.failedAttempts, lockedUntil: state.lockedUntil })
      .where(eq(users.id, id));
  }

  /** ADIÇÃO (Onda 3 — self-service): lote por ids (entregadores das listagens de entrega). */
  async findByIds(ids: Id[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.query.users.findMany({ where: inArray(users.id, ids) });
    return rows.map(toUserRecord);
  }

  /** ADIÇÃO (Onda 3 — self-service): usuários de um papel, ordem alfabética. */
  async listByRole(role: UserRecord["role"]): Promise<UserRecord[]> {
    const rows = await this.tx.query.users.findMany({
      where: eq(users.role, role),
      orderBy: (u, { asc: asc_ }) => asc_(u.name),
    });
    return rows.map(toUserRecord);
  }

  /**
   * Create/update. O PIN NÃO é gerado aqui: o use case hasheia com argon2 e
   * passa em `pinHash` (obrigatório na criação — coluna NOT NULL).
   * Quando `pinHash` muda, zera `failedAttempts`/`lockedUntil`, exatamente
   * como `updateUserUsecase` faz hoje. Unicidade de email continua no use
   * case (não há unique index em `user.email`).
   */
  async save(input: Partial<UserRecord> & Pick<UserRecord, "name" | "role">): Promise<UserRecord> {
    if (input.id) {
      const existing = await this.tx.query.users.findFirst({ where: eq(users.id, input.id) });
      if (!existing) throw Errors.notFound("Usuário");
      const pinChanged = input.pinHash !== undefined && input.pinHash !== existing.pinHash;
      const [row] = await this.tx
        .update(users)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          // ADIÇÃO (Onda identidade): vínculo com a conta global. `null` desvincula.
          ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
          ...(input.photoPath !== undefined ? { photoPath: input.photoPath } : {}),
          ...(pinChanged ? { pinHash: input.pinHash, failedAttempts: 0, lockedUntil: null } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, input.id))
        .returning();
      if (!row) throw Errors.notFound("Usuário");
      return toUserRecord(row);
    }

    if (!input.pinHash) throw Errors.validationFailed({ field: "pinHash" });
    const [row] = await this.tx
      .insert(users)
      .values({
        name: input.name,
        role: input.role,
        pinHash: input.pinHash,
        active: input.active ?? true,
        phone: input.phone ?? null,
        email: input.email ?? null,
        accountId: input.accountId ?? null,
        photoPath: input.photoPath ?? null,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return toUserRecord(row);
  }
}


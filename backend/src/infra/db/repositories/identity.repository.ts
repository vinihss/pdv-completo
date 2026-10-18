/**
 * Adapter Postgres do port `IdentityRepository` — tabelas GLOBAIS de identidade
 * (`public.account`, `public.auth_session`, `public.password_reset`).
 *
 * SQL CRU qualificado com `public.` de propósito, pela MESMA razão do registry
 * de tenants (`infra/tenant/registry.ts`): `infra/db/schema.ts` descreve as
 * tabelas que vivem DENTRO do schema do tenant — registrá-las ali faria o
 * `drizzle-kit generate` produzir `CREATE TABLE account` para dentro de cada
 * loja. Estas tabelas são globais por decisão de produto (docs/26 §3).
 *
 * Roda na transação da sessão de tenant (`Tx`): em `runInTenantScope` o
 * `search_path` do pool aponta para o schema da loja, e por isso TODO nome é
 * qualificado — sem o `public.` a query acharia (ou não acharia) a tabela errada
 * conforme o esquema de fallback do `search_path`.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import type {
  AccountRecord,
  AccountStatus,
  AuthSessionRecord,
  IdentityRepository,
  PasswordResetRecord,
} from "../../../application/identity/ports/identity-repository.ts";

const ACCOUNT_COLUMNS = sql`id, email, password_hash, name, status, must_change_password, created_at, updated_at`;
const SESSION_COLUMNS = sql`id, account_id, refresh_hash, device_id, tenant_slug, expires_at, revoked_at, rotated_from, created_at`;
const RESET_COLUMNS = sql`id, account_id, token_hash, expires_at, used_at, created_at`;

interface AccountRow extends Record<string, unknown> {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  status: string;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  refresh_hash: string;
  device_id: string | null;
  tenant_slug: string | null;
  expires_at: string;
  revoked_at: string | null;
  rotated_from: string | null;
  created_at: string;
}

interface ResetRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    status: (row.status === "suspended" ? "suspended" : "active") as AccountStatus,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSession(row: SessionRow): AuthSessionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    deviceId: row.device_id,
    tenantSlug: row.tenant_slug,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    rotatedFrom: row.rotated_from,
    createdAt: row.created_at,
  };
}

function toReset(row: ResetRow): PasswordResetRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly tx: Tx) {}

  // ---------- account ----------

  async findAccountByEmail(email: string): Promise<AccountRecord | null> {
    const { rows } = await this.tx.execute<AccountRow>(
      sql`SELECT ${ACCOUNT_COLUMNS} FROM public.account WHERE lower(email) = lower(${email}) LIMIT 1`,
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async findAccountById(id: string): Promise<AccountRecord | null> {
    const { rows } = await this.tx.execute<AccountRow>(
      sql`SELECT ${ACCOUNT_COLUMNS} FROM public.account WHERE id = ${id} LIMIT 1`,
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async ensureAccount(input: {
    id: string;
    email: string;
    name?: string | null;
    now: string;
  }): Promise<AccountRecord> {
    // O índice único é sobre `lower(email)` — o conflito é inferido pela
    // expressão. DORMANT: `password_hash` fica NULL até o primeiro convite.
    const inserted = await this.tx.execute<AccountRow>(sql`
      INSERT INTO public.account (id, email, name, created_at, updated_at)
      VALUES (${input.id}, ${input.email}, ${input.name ?? null}, ${input.now}, ${input.now})
      ON CONFLICT (lower(email)) DO NOTHING
      RETURNING ${ACCOUNT_COLUMNS}
    `);
    if (inserted.rows[0]) return toAccount(inserted.rows[0]);

    const existing = await this.findAccountByEmail(input.email);
    if (!existing) throw new Error("[identity] conta não encontrada após conflito de email");
    return existing;
  }

  async setAccountPassword(
    id: string,
    input: { passwordHash: string; mustChangePassword: boolean; now: string },
  ): Promise<void> {
    await this.tx.execute(sql`
      UPDATE public.account
         SET password_hash = ${input.passwordHash},
             must_change_password = ${input.mustChangePassword},
             updated_at = ${input.now}
       WHERE id = ${id}
    `);
  }

  // ---------- auth_session ----------

  async createAuthSession(input: {
    id: string;
    accountId: string;
    refreshHash: string;
    tenantSlug?: string | null;
    deviceId?: string | null;
    expiresAt: string;
    rotatedFrom?: string | null;
    now: string;
  }): Promise<AuthSessionRecord> {
    const { rows } = await this.tx.execute<SessionRow>(sql`
      INSERT INTO public.auth_session
        (id, account_id, refresh_hash, device_id, tenant_slug, expires_at, rotated_from, created_at, last_seen_at)
      VALUES (
        ${input.id}, ${input.accountId}, ${input.refreshHash}, ${input.deviceId ?? null},
        ${input.tenantSlug ?? null}, ${input.expiresAt}, ${input.rotatedFrom ?? null}, ${input.now}, ${input.now}
      )
      RETURNING ${SESSION_COLUMNS}
    `);
    const row = rows[0];
    if (!row) throw new Error("[identity] falha ao criar auth_session");
    return toSession(row);
  }

  async findAuthSessionByHash(refreshHash: string): Promise<AuthSessionRecord | null> {
    const { rows } = await this.tx.execute<SessionRow>(
      sql`SELECT ${SESSION_COLUMNS} FROM public.auth_session WHERE refresh_hash = ${refreshHash} LIMIT 1`,
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async claimAuthSession(refreshHash: string, now: string): Promise<AuthSessionRecord | null> {
    const { rows } = await this.tx.execute<SessionRow>(sql`
      UPDATE public.auth_session
         SET revoked_at = ${now}, last_seen_at = ${now}
       WHERE refresh_hash = ${refreshHash}
         AND revoked_at IS NULL
         AND expires_at > ${now}
      RETURNING ${SESSION_COLUMNS}
    `);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async revokeAuthSessionFamily(id: string, now: string): Promise<number> {
    const result = await this.tx.execute(sql`
      WITH RECURSIVE family AS (
        SELECT id FROM public.auth_session WHERE id = ${id}
        UNION ALL
        SELECT s.id FROM public.auth_session s JOIN family f ON s.rotated_from = f.id
      )
      UPDATE public.auth_session
         SET revoked_at = ${now}
       WHERE id IN (SELECT id FROM family)
         AND revoked_at IS NULL
    `);
    return result.rowCount ?? 0;
  }

  async revokeAuthSessionByHash(refreshHash: string, now: string): Promise<void> {
    await this.tx.execute(sql`
      UPDATE public.auth_session
         SET revoked_at = ${now}
       WHERE refresh_hash = ${refreshHash}
         AND revoked_at IS NULL
    `);
  }

  async revokeAllAuthSessions(accountId: string, now: string): Promise<number> {
    const result = await this.tx.execute(sql`
      UPDATE public.auth_session
         SET revoked_at = ${now}
       WHERE account_id = ${accountId}
         AND revoked_at IS NULL
    `);
    return result.rowCount ?? 0;
  }

  // ---------- password_reset ----------

  async createPasswordReset(input: {
    id: string;
    accountId: string;
    tokenHash: string;
    expiresAt: string;
    now: string;
  }): Promise<PasswordResetRecord> {
    const { rows } = await this.tx.execute<ResetRow>(sql`
      INSERT INTO public.password_reset (id, account_id, token_hash, expires_at, created_at)
      VALUES (${input.id}, ${input.accountId}, ${input.tokenHash}, ${input.expiresAt}, ${input.now})
      RETURNING ${RESET_COLUMNS}
    `);
    const row = rows[0];
    if (!row) throw new Error("[identity] falha ao criar password_reset");
    return toReset(row);
  }

  async findPasswordResetByHash(tokenHash: string): Promise<PasswordResetRecord | null> {
    const { rows } = await this.tx.execute<ResetRow>(
      sql`SELECT ${RESET_COLUMNS} FROM public.password_reset WHERE token_hash = ${tokenHash} LIMIT 1`,
    );
    return rows[0] ? toReset(rows[0]) : null;
  }

  async claimPasswordResetUsage(id: string, usedAt: string): Promise<boolean> {
    const result = await this.tx.execute(sql`
      UPDATE public.password_reset
         SET used_at = ${usedAt}
       WHERE id = ${id}
         AND used_at IS NULL
    `);
    return (result.rowCount ?? 0) > 0;
  }

  async invalidatePendingPasswordResets(accountId: string, usedAt: string): Promise<number> {
    const result = await this.tx.execute(sql`
      UPDATE public.password_reset
         SET used_at = ${usedAt}
       WHERE account_id = ${accountId}
         AND used_at IS NULL
    `);
    return result.rowCount ?? 0;
  }
}

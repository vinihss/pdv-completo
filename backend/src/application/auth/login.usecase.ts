// Login por PIN — migrado para ports + Unit-of-Work (Onda auth).
//
// Nenhuma importação de infra/integrations/config nem de Drizzle: a leitura e
// as escritas de tentativa de login saem por `session.users`, o escopo de
// tenant corrente por um port (`TenantScopeStore`), a resolução de tenant por
// host e a validação do aparelho provisionado (docs/21 §5.3/§6) são injetadas
// via `deps`, e o segredo do JWT também (a application não lê `config`).
//
// Cada escrita roda em seu PRÓPRIO `uow.run`: o incremento de tentativa errada
// precisa COMMITAR mesmo quando o login lança em seguida (se estivesse na
// mesma transação do throw, o rollback apagaria a contagem e a conta nunca
// travaria).
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { Errors } from "../../domain/errors.js";
import { photoUrl } from "../user/shared/user-helpers.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { TenantScopeStore } from "../ports/effects.js";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60_000;

export interface LoginUsecaseDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /**
   * Escopo de tenant do request (ALS). O `login` consulta e entra no escopo
   * quando o ALS está vazio mas o host foi fornecido (workaround de propagação
   * do ALS no Fastify).
   */
  scope: TenantScopeStore;
  /** Resolve o tenant pelo host (usado quando o ALS está vazio). */
  resolveTenant: (host: string | undefined) => Promise<{ slug: string; schemaName: string; isDefault: boolean }>;
  /** Valida o vínculo aparelho→usuário (docs/21 §5.3) e toca `last_seen_at`. */
  assertDeviceForLogin: (userId: string, deviceId: string) => Promise<void>;
  /** Segredo do JWT (a application não lê `config`). */
  jwtSecret: string;
}

export function createLoginUsecase(deps: LoginUsecaseDeps) {
  /**
   * Autentica um usuário por PIN. `deviceId` opcional (docs/21 §5.3/§6): quando
   * presente, o aparelho precisa ser conhecido, ativo, não revogado e vinculado
   * ao `userId`; sem ele, comportamento inalterado (PWA/tablet compartilhado).
   * `host` opcional: quando fornecido, resolve o tenant manualmente se o ALS
   * estiver vazio (workaround para problema de propagação do ALS no Fastify).
   */
  async function loginUsecase(userId: string, rawPin: string, deviceId?: string, host?: string) {
    // Workaround: se o ALS estiver vazio mas o host foi fornecido, resolve o
    // tenant manualmente antes de qualquer acesso ao banco.
    if (!deps.scope.current() && host) {
      const tenant = await deps.resolveTenant(host);
      deps.scope.enter({ schemaName: tenant.schemaName, slug: tenant.slug, isDefault: tenant.isDefault });
    }

    const u = await deps.uow.run(deps.tenant(), (session) => session.users.findById(userId));
    if (!u || !u.active) throw Errors.invalidCredentials();

    if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
      throw Errors.invalidCredentials(); // mensagem genérica de propósito — não vaza motivo do bloqueio
    }

    const valid = await argon2.verify(u.pinHash, rawPin);
    if (!valid) {
      // Incrementa em transação PRÓPRIA para o COMMIT sobreviver ao throw.
      const attempts = u.failedAttempts + 1;
      const shouldLock = attempts >= MAX_ATTEMPTS;
      await deps.uow.run(deps.tenant(), (session) =>
        session.users.setLoginState(userId, {
          failedAttempts: attempts,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCK_MS).toISOString() : null,
        }),
      );
      throw Errors.invalidCredentials();
    }

    await deps.uow.run(deps.tenant(), (session) =>
      session.users.setLoginState(userId, { failedAttempts: 0, lockedUntil: null }),
    );

    if (deviceId) await deps.assertDeviceForLogin(userId, deviceId);

    const tenant = deps.scope.current();
    if (!tenant) {
      throw new Error("[auth] login sem contexto de tenant — onRequest não resolveu");
    }
    const token = jwt.sign(
      {
        sub: u.id,
        role: u.role,
        tenant: tenant.slug,
      },
      deps.jwtSecret,
      { expiresIn: "12h" },
    );
    // A foto vai na sessão (não no JWT) para a identidade do app logado mostrar
    // o avatar sem uma segunda chamada.
    return { token, user: { id: u.id, name: u.name, role: u.role, photoPath: photoUrl(u.photoPath, "user") } };
  }

  return { loginUsecase };
}

export type LoginUsecase = ReturnType<typeof createLoginUsecase>;

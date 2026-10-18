/**
 * Dependências compartilhadas do módulo de equipe (usuários).
 *
 * Injetadas por construtor em cada Use Case (Command Pattern / Single Use Case
 * Class): nenhuma classe conhece adapters concretos, só estes ports. O `tenant`
 * é resolvido a cada chamada (ALS/request corrente) e nunca memoizado.
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { FileStorage, Mailer } from "../../ports/effects.js";

export interface UserDependencies {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Upload/remoção da foto do usuário em disco. */
  storage: FileStorage;
  /**
   * ADIÇÃO (Onda identidade — docs/26 §4): envio da senha temporária do convite
   * (`POST /users`). `isConfigured()` decide o 503 ANTES de qualquer escrita —
   * sem SMTP o convite não deixa conta nem usuário para trás (decisão 9).
   */
  mailer: Mailer;
  /**
   * Invalida o cache de "usuário ativo" do middleware (infra/auth) na cascata
   * de desativação — a sessão JWT aberta cai na próxima requisição.
   */
  invalidateActiveUser: (userId: string) => void;
}

/** Nome legado da interface de dependências (o módulo passou a chamá-la `UserDependencies`). */
export type UserUsecasesDeps = UserDependencies;

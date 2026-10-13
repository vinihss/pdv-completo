/**
 * Dependências compartilhadas do módulo de clientes.
 *
 * Injetadas por construtor em cada Use Case (Command Pattern / Single Use Case
 * Class): nenhuma classe conhece adapters concretos, só estes ports. O `tenant`
 * é resolvido a cada chamada (ALS/request corrente) e nunca memoizado.
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { FileStorage } from "../../ports/effects.js";

export interface CustomerDependencies {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Upload/remoção da foto do cliente em disco. */
  storage: FileStorage;
}

/** Nome legado da interface de dependências (o módulo passou a chamá-la `CustomerDependencies`). */
export type CustomerUsecasesDeps = CustomerDependencies;

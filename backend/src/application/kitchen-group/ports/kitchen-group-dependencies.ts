/**
 * Dependências compartilhadas do módulo de grupos de produção.
 *
 * Injetadas por construtor em cada Use Case (Command Pattern / Single Use Case
 * Class): nenhuma classe conhece adapters concretos, só estes ports. O `tenant`
 * é resolvido a cada chamada (ALS/request corrente) e nunca memoizado.
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { TenantCache } from "../../ports/effects.js";

export interface KitchenGroupDependencies {
  uow: TenantUnitOfWork;
  cache: TenantCache;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

/** Nome legado da interface de dependências (o módulo passou a chamá-la `KitchenGroupDependencies`). */
export type KitchenGroupUsecasesDeps = KitchenGroupDependencies;

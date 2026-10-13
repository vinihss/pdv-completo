/**
 * Dependências compartilhadas do módulo de produtos.
 *
 * Injetadas por construtor em cada Use Case (Command Pattern / Single Use Case
 * Class): nenhuma classe conhece adapters concretos, só estes ports. O
 * `tenant` é resolvido a cada chamada (ALS/request corrente) e nunca
 * memoizado.
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { TenantCache, FileStorage } from "../../ports/effects.js";

export interface ProductDependencies {
  uow: TenantUnitOfWork;
  cache: TenantCache;
  storage: FileStorage;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

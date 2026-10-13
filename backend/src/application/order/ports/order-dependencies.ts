/**
 * Deps do hub de pedidos: Unit-of-Worker + tenant resolvido POR CHAMADA + os
 * três efeitos pós-commit/settings (impressão, cache de relatórios e
 * `store_settings`). Nada de infra concreta aqui — quem instancia é a
 * composition root (`infra/composition/default-usecases.ts`).
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { OrderPrinter, StoreSettingsReader, TenantCache } from "../../ports/effects.js";

export interface OrderDependencies {
  uow: TenantUnitOfWork;
  cache: TenantCache;
  printer: OrderPrinter;
  settings: StoreSettingsReader;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

/** Nome legado da interface de dependências (o módulo passou a chamá-la `OrderDependencies`). */
export type OrderUsecasesDeps = OrderDependencies;

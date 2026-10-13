/**
 * Dependências compartilhadas do módulo de relatórios.
 *
 * Injetadas por construtor em cada Use Case (Command Pattern / Single Use Case
 * Class): nenhuma classe conhece adapters concretos, só estes ports. O `tenant`
 * é resolvido a cada chamada (ALS/request corrente) e nunca memoizado.
 */
import type { TenantUnitOfWork } from "../../ports/unit-of-work.js";
import type { TenantContext } from "../../ports/tenant-context.js";
import type { TenantCache } from "../../ports/effects.js";

export interface ReportDependencies {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Cache por schema (`reports:*`, TTL 300) — set pós-commit. */
  cache: TenantCache;
}

/** Nome legado da interface de dependências do relatório de vendas. */
export type ReportUsecasesDeps = ReportDependencies;
/** Nome legado da interface de dependências da visão geral. */
export type OverviewReportUsecasesDeps = ReportDependencies;
/** Nome legado da interface de dependências do relatório de entregas. */
export type DeliveriesReportUsecasesDeps = ReportDependencies;

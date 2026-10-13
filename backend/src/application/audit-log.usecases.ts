/**
 * Auditoria — ONDA 3B da refatoração arquitetural.
 *
 * Factory pura: nenhuma importação de infra/Drizzle. A leitura da trilha passa
 * pelo port `session.auditLog` (TenantSession), na janela transacional do UoW.
 */
import type { TenantUnitOfWork } from "./ports/unit-of-work.js";
import type { TenantContext } from "./ports/tenant-context.js";

export interface AuditLogUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

export function createAuditLogUsecases(deps: AuditLogUsecasesDeps) {
  return {
    async listAuditLogUsecase(input: { orderId?: string; limit: number; offset: number }) {
      return deps.uow.run(deps.tenant(), (session) => session.auditLog.list(input));
    },
  };
}

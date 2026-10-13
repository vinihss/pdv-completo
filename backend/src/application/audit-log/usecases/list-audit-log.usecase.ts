/**
 * GET /audit-log — leitura paginada da trilha de auditoria.
 *
 * A leitura passa pelo port `session.auditLog` (TenantSession), na janela
 * transacional do UoW. A escrita de trilha é `session.audit.record`, dentro da
 * transação de cada use case de domínio.
 */
import type { AuditLogDependencies } from "../ports/audit-log-dependencies.js";

export type ListAuditLogInput = {
  orderId?: string;
  limit: number;
  offset: number;
};

export class ListAuditLogUseCase {
  constructor(private readonly deps: AuditLogDependencies) {}

  async execute(input: ListAuditLogInput) {
    return this.deps.uow.run(this.deps.tenant(), (session) => session.auditLog.list(input));
  }
}

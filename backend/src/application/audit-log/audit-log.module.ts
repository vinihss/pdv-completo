/**
 * Módulo de trilha de auditoria — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências (injetado
 * via construtor) e expõe as instâncias como propriedades readonly.
 */
import type { AuditLogDependencies } from "./ports/audit-log-dependencies.js";
import { ListAuditLogUseCase } from "./usecases/list-audit-log.usecase.js";

export class AuditLogModule {
  public readonly listAuditLog: ListAuditLogUseCase;

  constructor(deps: AuditLogDependencies) {
    this.listAuditLog = new ListAuditLogUseCase(deps);
  }
}

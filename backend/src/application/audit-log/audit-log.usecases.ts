/**
 * Auditoria (trilha) — ponto de entrada de COMPATIBILIDADE.
 *
 * A implementação foi decomposta em um Use Case por operação (Command Pattern
 * / Single Use Case Class), em `usecases/list-audit-log.usecase.ts`, com as
 * dependências em `ports/audit-log-dependencies.ts` e o facade `AuditLogModule`
 * em `audit-log.module.ts`.
 *
 * Este arquivo mantém a factory `createAuditLogUsecases` com o NOME LEGADO
 * (`listAuditLogUsecase`) para a composition root
 * (`infra/composition/default-usecases.ts`), que re-exporta para as rotas.
 * Nada muda na assinatura observada de fora. Para uso novo, prefira
 * `AuditLogModule` e `.listAuditLog.execute(...)`.
 */
import { AuditLogModule } from "./audit-log.module.js";
import type { AuditLogDependencies } from "./ports/audit-log-dependencies.js";
import type { ListAuditLogInput } from "./usecases/list-audit-log.usecase.js";

export { AuditLogModule };
export type { AuditLogDependencies };
export type { AuditLogUsecasesDeps } from "./ports/audit-log-dependencies.js";
export { ListAuditLogUseCase, type ListAuditLogInput } from "./usecases/list-audit-log.usecase.js";

export function createAuditLogUsecases(deps: AuditLogDependencies) {
  const module = new AuditLogModule(deps);
  return {
    listAuditLogUsecase: (input: ListAuditLogInput) => module.listAuditLog.execute(input),
  };
}

/**
 * Composição de domínio — `audit-log` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { auditLogInstances } from "../default-usecases.js";

export const listAuditLogUsecase = auditLogInstances.listAuditLogUsecase;

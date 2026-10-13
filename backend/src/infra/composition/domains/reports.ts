/**
 * Composição de domínio — `reports` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { deliveriesReportInstances, overviewReportInstances, reportInstances } from "../default-usecases.js";

export const salesReportUsecase = reportInstances.salesReportUsecase;
export const overviewReportUsecase = overviewReportInstances.overviewReportUsecase;
export const deliveriesReportUsecase = deliveriesReportInstances.deliveriesReportUsecase;

/**
 * Composição de domínio — `alert` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { alertInstances } from "../default-usecases.js";

export const listAlertsUsecase = alertInstances.listAlertsUsecase;
export const markAlertsReadUsecase = alertInstances.markAlertsReadUsecase;

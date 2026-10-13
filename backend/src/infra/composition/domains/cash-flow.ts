/**
 * Composição de domínio — `cash-flow` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { cashFlowInstances } from "../default-usecases.js";

export const getCurrentDrawerUsecase = cashFlowInstances.getCurrentDrawerUsecase;
export const listCashDrawersUsecase = cashFlowInstances.listCashDrawersUsecase;
export const getCashDrawerDetailUsecase = cashFlowInstances.getCashDrawerDetailUsecase;
export const sumCashDrawersSummaryUsecase = cashFlowInstances.sumCashDrawersSummaryUsecase;
export const openCashDrawerUsecase = cashFlowInstances.openCashDrawerUsecase;
export const registerCashMovementUsecase = cashFlowInstances.registerCashMovementUsecase;
export const closeCashDrawerUsecase = cashFlowInstances.closeCashDrawerUsecase;

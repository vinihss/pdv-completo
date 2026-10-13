/**
 * Composição de domínio — `stock` (Onda 5).
 */
import { purchaseInstances, stockInstances } from "../default-usecases.js";

export const listStockUsecase = stockInstances.listStockUsecase;
export const getStockMovementsUsecase = stockInstances.getStockMovementsUsecase;
export const registerStockMovementUsecase = stockInstances.registerStockMovementUsecase;
export const inventoryValuationUsecase = purchaseInstances.inventoryValuationUsecase;

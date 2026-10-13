/**
 * Composição de domínio — `finance` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { purchaseInstances, refundInstances } from "../default-usecases.js";

export const listSuppliersUsecase = purchaseInstances.listSuppliersUsecase;
export const createSupplierUsecase = purchaseInstances.createSupplierUsecase;
export const updateSupplierUsecase = purchaseInstances.updateSupplierUsecase;
export const createPurchaseUsecase = purchaseInstances.createPurchaseUsecase;
export const listPurchasesUsecase = purchaseInstances.listPurchasesUsecase;
export const getPurchaseUsecase = purchaseInstances.getPurchaseUsecase;
export const inventoryValuationUsecase = purchaseInstances.inventoryValuationUsecase;
export const refundOrderPaymentUsecase = refundInstances.refundOrderPaymentUsecase;
export const listOrderRefundsUsecase = refundInstances.listOrderRefundsUsecase;

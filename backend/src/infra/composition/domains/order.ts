/**
 * Composição de domínio — `order` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { orderInstances } from "../default-usecases.js";

export const openOrderUsecase = orderInstances.openOrderUsecase;
export const addItemsUsecase = orderInstances.addItemsUsecase;
export const updateItemStatusUsecase = orderInstances.updateItemStatusUsecase;
export const deleteItemUsecase = orderInstances.deleteItemUsecase;
export const setOrderPaymentsUsecase = orderInstances.setOrderPaymentsUsecase;
export const confirmOrderPaymentUsecase = orderInstances.confirmOrderPaymentUsecase;
export const deleteOrderPaymentUsecase = orderInstances.deleteOrderPaymentUsecase;
export const registerPaymentUsecase = orderInstances.registerPaymentUsecase;
export const closeOrderUsecase = orderInstances.closeOrderUsecase;
export const cancelOrderUsecase = orderInstances.cancelOrderUsecase;
export const getOrderUsecase = orderInstances.getOrderUsecase;
export const listOrdersUsecase = orderInstances.listOrdersUsecase;
export const listTablesUsecase = orderInstances.listTablesUsecase;

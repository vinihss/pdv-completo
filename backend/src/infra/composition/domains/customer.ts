/**
 * Composição de domínio — `customer` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { customerAddressInstances, customerInstances } from "../default-usecases.js";

export const listCustomersUsecase = customerInstances.listCustomersUsecase;
export const getCustomerDetailUsecase = customerInstances.getCustomerDetailUsecase;
export const createCustomerUsecase = customerInstances.createCustomerUsecase;
export const updateCustomerUsecase = customerInstances.updateCustomerUsecase;
export const searchCustomersUsecase = customerInstances.searchCustomersUsecase;
export const saveCustomerPhotoUsecase = customerInstances.saveCustomerPhotoUsecase;
export const clearCustomerPhotoUsecase = customerInstances.clearCustomerPhotoUsecase;
export const listCustomerOrdersUsecase = customerInstances.listCustomerOrdersUsecase;
export const customerSummaryUsecase = customerInstances.customerSummaryUsecase;
export const addCustomerAddressUsecase = customerAddressInstances.addCustomerAddressUsecase;
export const setDefaultCustomerAddressUsecase = customerAddressInstances.setDefaultCustomerAddressUsecase;
export const deleteCustomerAddressUsecase = customerAddressInstances.deleteCustomerAddressUsecase;

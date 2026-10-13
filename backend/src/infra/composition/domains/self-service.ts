/**
 * Composição de domínio — `self-service` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { cartInstances, customerAddressInstances, deliveryInstances, managerDeliveryStatusInstances, menuInstances, orderIntakeInstances, selfServiceCancelInstances, selfServiceDeliveryInstances } from "../default-usecases.js";

export const getPublicMenuUsecase = menuInstances.getPublicMenuUsecase;
export const calcularEntregaUsecase = deliveryInstances.calcularEntregaUsecase;
export const getDeliveryPricingUsecase = deliveryInstances.getDeliveryPricingUsecase;
export const geocodeRestaurantUsecase = deliveryInstances.geocodeRestaurantUsecase;
export const lookupCustomerByPhoneUsecase = customerAddressInstances.lookupCustomerByPhoneUsecase;
export const createSelfServiceCustomerUsecase = customerAddressInstances.createSelfServiceCustomerUsecase;
export const addCustomerAddressUsecase = customerAddressInstances.addCustomerAddressUsecase;
export const listCustomerAddressesUsecase = customerAddressInstances.listCustomerAddressesUsecase;
export const setDefaultCustomerAddressUsecase = customerAddressInstances.setDefaultCustomerAddressUsecase;
export const deleteCustomerAddressUsecase = customerAddressInstances.deleteCustomerAddressUsecase;
export const cancelSelfServiceOrderUsecase = selfServiceCancelInstances.cancelSelfServiceOrderUsecase;
export const getCustomerCartUsecase = cartInstances.getCustomerCartUsecase;
export const saveCustomerCartUsecase = cartInstances.saveCustomerCartUsecase;
export const clearCustomerCartUsecase = cartInstances.clearCustomerCartUsecase;
export const createSelfServiceOrderUsecase = orderIntakeInstances.createSelfServiceOrderUsecase;
export const getSelfServiceOrderStatusUsecase = orderIntakeInstances.getSelfServiceOrderStatusUsecase;
export const getActiveSelfServiceOrderByPhoneUsecase = orderIntakeInstances.getActiveSelfServiceOrderByPhoneUsecase;
export const listCourierDeliveriesUsecase = selfServiceDeliveryInstances.listCourierDeliveriesUsecase;
export const dispatchDeliveryUsecase = selfServiceDeliveryInstances.dispatchDeliveryUsecase;
export const deliverDeliveryUsecase = selfServiceDeliveryInstances.deliverDeliveryUsecase;
export const failDeliveryUsecase = selfServiceDeliveryInstances.failDeliveryUsecase;
export const reportCourierLocationUsecase = selfServiceDeliveryInstances.reportCourierLocationUsecase;
export const listCourierLocationsUsecase = selfServiceDeliveryInstances.listCourierLocationsUsecase;
export const listCouriersUsecase = selfServiceDeliveryInstances.listCouriersUsecase;
export const listManagerDeliveriesUsecase = selfServiceDeliveryInstances.listManagerDeliveriesUsecase;
export const assignCourierUsecase = selfServiceDeliveryInstances.assignCourierUsecase;
export const setDeliveryStatusUsecase = managerDeliveryStatusInstances.setDeliveryStatusUsecase;

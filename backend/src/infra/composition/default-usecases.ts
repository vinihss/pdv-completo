/**
 * Composition root provisória — ONDA 3A.
 *
 * Liga os adapters concretos (Postgres, cache, storage, efeitos)
 * às factories dos use cases migrados e exporta as funções com os
 * NOMES LEGADOS (`openOrderUsecase`, `listAlertsUsecase`, ...) para os
 * consumidores que ainda não foram migrados para injeção por composição.
 *
 * A composition root definitiva (`src/composition/build-app.ts`) substituirá
 * este arquivo quando todas as rotas estiverem recebendo deps via parâmetro.
 * Até lá, este módulo é o único ponto que conhece adapters concretos — os
 * use cases em `application/` só falam ports.
 */
import { currentTenantScope } from "../db/tenant-context.js";
import { PostgresTenantUnitOfWork } from "../db/postgres-tenant-unit-of-work.js";
import { createPostgresTenantSession } from "../db/postgres-session.js";
import { TenantCacheAdapter, alsTenantCache } from "../cache/tenant-cache-adapter.js";
import { StoragePortAdapter } from "../storage/storage-port-adapter.js";
import { createOrderNotifier } from "../realtime/outbox-order-notifier.js";
import { PostgresStoreSettingsReader } from "../db/store-settings-reader.js";
import { OrderPrinterAdapter } from "../../integrations/printer/order-printer-adapter.js";
import { GeocodingPortAdapter } from "../../integrations/maps/geocoding-port-adapter.js";
import { RoutingPortAdapter } from "../../integrations/maps/routing-port-adapter.js";
import { createOrderUsecases } from "../../application/order/order.usecases.js";
import { createAlertUsecases } from "../../application/alert/alert.usecases.js";
import { createStockUsecases } from "../../application/stock/stock.usecases.js";
import { createProductUsecases } from "../../application/product.usecases.js";
import { createCategoryUsecases } from "../../application/category.usecases.js";
import { createKitchenGroupUsecases } from "../../application/kitchen-group.usecases.js";
import { createMenuUsecases } from "../../application/self-service/menu.usecases.js";
import { createCartUsecases } from "../../application/self-service/cart.usecases.js";
import { createCustomerAddressUsecases } from "../../application/self-service/customer-address.usecases.js";
import { createSelfServiceCancelUsecases } from "../../application/self-service/cancel-order.usecase.js";
import {
  createCloseOrderAfterDelivery,
  createManagerDeliveryStatusUsecases,
} from "../../application/self-service/manager-delivery-status.usecase.js";
import { createSelfServiceDeliveryUsecases } from "../../application/self-service/delivery.usecases.js";
import { createOrderIntakeUsecases } from "../../application/self-service/order-intake.usecase.js";
import { createAuditLogUsecases } from "../../application/audit-log.usecases.js";
import { createDeliveryUsecases } from "../../application/delivery/calcular-entrega.usecase.js";
import { createStoreSettingsUsecases } from "../../application/store-settings.usecases.js";
import { createCustomerUsecases } from "../../application/customer.usecases.js";
import type { TenantContext } from "../../application/ports/tenant-context.js";
import type { GeocodingService, RoutingService } from "../../application/ports/effects.js";

// ---------------------------------------------------------------------------
// Tenant resolver: lê o ALS (contexto do request/worker corrente) e monta o
// TenantContext. É a única dependência de ALS neste módulo — os use cases
// recebem o contexto por parâmetro, nunca consultam o ALS diretamente.
// ---------------------------------------------------------------------------
function requireTenant(): TenantContext {
  const scope = currentTenantScope();
  if (!scope) {
    // Fallback: sem ALS (testes unitários, jobs), usa o schema padrão — como o
    // proxy `db` fazia antes (resolveTenantSchemaInScope → DEFAULT_TENANT_SCHEMA ?? "public").
    return {
      tenantId: "default",
      slug: "default",
      schemaName: process.env.DEFAULT_TENANT_SCHEMA ?? "public",
      source: "internal",
    };
  }
  return {
    tenantId: scope.slug,
    slug: scope.slug,
    schemaName: scope.schemaName,
    source: "http",
  };
}

// ---------------------------------------------------------------------------
// Adapters concretos (uma instância por processo; todas stateless além do tx)
// ---------------------------------------------------------------------------
const uow = new PostgresTenantUnitOfWork(createPostgresTenantSession);
const tenant = requireTenant;
// O cache expõe o schema por chamada (via ALS), igual ao `tenantCache`
// original — o adapter usa o wrapper `alsTenantCache` para satisfazer o
// port TenantCache com invalidatePrefix (prefixo + "*" = invalidatePattern).
const cache = alsTenantCache;
// Armazenamento fixa o schema explicitamente (o port FileStorage resolve
// tenant() por operação, mas o schemaName precisa ser conhecido). O
// resolveTenantSchema padrão (ALS) pode não estar ativo em jobs/webhooks,
// então usamos o explicit com fallback env:
const storageRoot = process.env.UPLOADS_DIR ?? "/tmp/uploads";
const storage = new StoragePortAdapter({ schemaName: "public" }, storageRoot);

// ---------------------------------------------------------------------------
// Factories dos use cases migrados
// ---------------------------------------------------------------------------
const orderInstances = createOrderUsecases({
  uow,
  cache: { get: () => Promise.resolve(null), set: () => Promise.resolve(), invalidatePrefix: () => Promise.resolve() },
  printer: new OrderPrinterAdapter(),
  settings: new PostgresStoreSettingsReader(),
  tenant,
});

const alertInstances = createAlertUsecases({ uow, tenant });

const stockInstances = createStockUsecases({ uow, tenant });

const productInstances = createProductUsecases({
  uow,
  cache,
  storage,
  tenant,
});

const categoryInstances = createCategoryUsecases({
  uow,
  cache,
  tenant,
});

const kitchenGroupInstances = createKitchenGroupUsecases({
  uow,
  cache,
  tenant,
});

const menuInstances = createMenuUsecases({
  uow,
  tenant,
});

// Self-service: carrinho (customer_cart), endereços (customer_address) e
// cancelamento pelo cliente. O cancelamento reusa o hub de pedidos — a
// dependência é injetada, não importada.
const cartInstances = createCartUsecases({ uow, tenant });
const customerAddressInstances = createCustomerAddressUsecases({ uow, tenant });
const selfServiceCancelInstances = createSelfServiceCancelUsecases({
  uow,
  tenant,
  cancelOrder: orderInstances.cancelOrderUsecase,
});

// Self-service: entrega (courier + manager) e checkout/status do cliente. O
// fechamento da comanda pós-entrega é composto UMA vez e injetado nos dois use
// cases que concluem entrega (entregador e gerente), evitando duas cópias
// divergindo.
const closeOrderAfterDelivery = createCloseOrderAfterDelivery({
  uow,
  tenant,
  registerPayment: orderInstances.registerPaymentUsecase,
  closeOrder: orderInstances.closeOrderUsecase,
});
const selfServiceDeliveryInstances = createSelfServiceDeliveryUsecases({
  uow,
  tenant,
  settings: new PostgresStoreSettingsReader(),
  printer: new OrderPrinterAdapter(),
  closeOrderAfterDelivery,
});
const managerDeliveryStatusInstances = createManagerDeliveryStatusUsecases({
  uow,
  tenant,
  settings: new PostgresStoreSettingsReader(),
  printer: new OrderPrinterAdapter(),
  closeOrderAfterDelivery,
});
const orderIntakeInstances = createOrderIntakeUsecases({
  uow,
  tenant,
  settings: new PostgresStoreSettingsReader(),
  addCustomerAddress: customerAddressInstances.addCustomerAddressUsecase,
  openOrder: orderInstances.openOrderUsecase,
  addItems: orderInstances.addItemsUsecase,
  registerPayment: orderInstances.registerPaymentUsecase,
  getOrder: orderInstances.getOrderUsecase,
});

const auditLogInstances = createAuditLogUsecases({ uow, tenant });

// ---------------------------------------------------------------------------
// Contexto delivery — geocoding/roteamento como SEAM de teste
// ---------------------------------------------------------------------------
// `setMapServices` preserva a semântica do antigo (módulo `calcular-entrega`):
// troca as implementações usadas pelo contexto delivery. Aqui a troca é feita
// nas referências que os adapters-delegate capturam no wiring abaixo — as
// chamadas seguintes enxergam a nova implementação.
let geocodingService: GeocodingService = new GeocodingPortAdapter();
let routingService: RoutingService = new RoutingPortAdapter();

export function setMapServices(geocoding: GeocodingService, routing: RoutingService): void {
  geocodingService = geocoding;
  routingService = routing;
}

const deliveryInstances = createDeliveryUsecases({
  uow,
  tenant,
  settings: new PostgresStoreSettingsReader(),
  cache,
  geocoding: {
    reverseGeocode: (coords) => geocodingService.reverseGeocode(coords),
    forwardGeocode: (address) => geocodingService.forwardGeocode(address),
  },
  routing: {
    calculateRoute: (origin, destination) => routingService.calculateRoute(origin, destination),
  },
});

// store-settings (Onda 3C) e customer (Onda 3C) — factories puras. O geocoding
// usa o MESMO seam do contexto delivery (`setMapServices`), então uma troca de
// implementação nos testes vale para os dois.
const storeSettingsInstances = createStoreSettingsUsecases({
  uow,
  tenant,
  cache,
  storage,
  geocoding: {
    reverseGeocode: (coords) => geocodingService.reverseGeocode(coords),
    forwardGeocode: (address) => geocodingService.forwardGeocode(address),
  },
});

const customerInstances = createCustomerUsecases({
  uow,
  tenant,
  storage,
});

// ---------------------------------------------------------------------------
// Exports legados — mesma assinatura de antes da migração (o `deps` some)
// ---------------------------------------------------------------------------

// order.usecases
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

// alert.usecases
export const listAlertsUsecase = alertInstances.listAlertsUsecase;
export const markAlertsReadUsecase = alertInstances.markAlertsReadUsecase;

// stock.usecases
export const listStockUsecase = stockInstances.listStockUsecase;
export const getStockMovementsUsecase = stockInstances.getStockMovementsUsecase;
export const registerStockMovementUsecase = stockInstances.registerStockMovementUsecase;

// category
export const listCategoriesUsecase = categoryInstances.listCategoriesUsecase;
export const createCategoryUsecase = categoryInstances.createCategoryUsecase;
export const updateCategoryUsecase = categoryInstances.updateCategoryUsecase;
export const deleteCategoryUsecase = categoryInstances.deleteCategoryUsecase;

// kitchen-group
export const listKitchenGroupsUsecase = kitchenGroupInstances.listKitchenGroupsUsecase;
export const createKitchenGroupUsecase = kitchenGroupInstances.createKitchenGroupUsecase;
export const updateKitchenGroupUsecase = kitchenGroupInstances.updateKitchenGroupUsecase;
export const deleteKitchenGroupUsecase = kitchenGroupInstances.deleteKitchenGroupUsecase;

// product
export const listProductsUsecase = productInstances.listProductsUsecase;
export const createProductUsecase = productInstances.createProductUsecase;
export const updateProductUsecase = productInstances.updateProductUsecase;
export const setProductActiveUsecase = productInstances.setProductActiveUsecase;
export const saveProductImageUsecase = productInstances.saveProductImageUsecase;
export const clearProductImageUsecase = productInstances.clearProductImageUsecase;

// kitchen-group (reexports for compatibility — same names)
export const listKitchenGroupsLegacyUsecase = kitchenGroupInstances.listKitchenGroupsUsecase;

// menu
export const getPublicMenuUsecase = menuInstances.getPublicMenuUsecase;

// self-service — carrinho (customer_cart)
export const getCustomerCartUsecase = cartInstances.getCustomerCartUsecase;
export const saveCustomerCartUsecase = cartInstances.saveCustomerCartUsecase;
export const clearCustomerCartUsecase = cartInstances.clearCustomerCartUsecase;

// self-service — cliente/endereços (customer_address)
export const lookupCustomerByPhoneUsecase = customerAddressInstances.lookupCustomerByPhoneUsecase;
export const createSelfServiceCustomerUsecase = customerAddressInstances.createSelfServiceCustomerUsecase;
export const addCustomerAddressUsecase = customerAddressInstances.addCustomerAddressUsecase;
export const listCustomerAddressesUsecase = customerAddressInstances.listCustomerAddressesUsecase;
export const setDefaultCustomerAddressUsecase = customerAddressInstances.setDefaultCustomerAddressUsecase;
export const deleteCustomerAddressUsecase = customerAddressInstances.deleteCustomerAddressUsecase;

// self-service — cancelamento pelo cliente
export const cancelSelfServiceOrderUsecase = selfServiceCancelInstances.cancelSelfServiceOrderUsecase;

// self-service — entrega (courier + manager)
export const listCourierDeliveriesUsecase = selfServiceDeliveryInstances.listCourierDeliveriesUsecase;
export const dispatchDeliveryUsecase = selfServiceDeliveryInstances.dispatchDeliveryUsecase;
export const deliverDeliveryUsecase = selfServiceDeliveryInstances.deliverDeliveryUsecase;
export const failDeliveryUsecase = selfServiceDeliveryInstances.failDeliveryUsecase;
export const listManagerDeliveriesUsecase = selfServiceDeliveryInstances.listManagerDeliveriesUsecase;
export const assignCourierUsecase = selfServiceDeliveryInstances.assignCourierUsecase;
export const reportCourierLocationUsecase = selfServiceDeliveryInstances.reportCourierLocationUsecase;
export const listCourierLocationsUsecase = selfServiceDeliveryInstances.listCourierLocationsUsecase;
export const listCouriersUsecase = selfServiceDeliveryInstances.listCouriersUsecase;
export const setDeliveryStatusUsecase = managerDeliveryStatusInstances.setDeliveryStatusUsecase;

// self-service — checkout/status do cliente
export const createSelfServiceOrderUsecase = orderIntakeInstances.createSelfServiceOrderUsecase;
export const getSelfServiceOrderStatusUsecase = orderIntakeInstances.getSelfServiceOrderStatusUsecase;
export const getActiveSelfServiceOrderByPhoneUsecase = orderIntakeInstances.getActiveSelfServiceOrderByPhoneUsecase;

// audit-log
export const listAuditLogUsecase = auditLogInstances.listAuditLogUsecase;

// delivery (calcular-entrega / delivery-pricing / geocode-restaurant)
export const calcularEntregaUsecase = deliveryInstances.calcularEntregaUsecase;
export const getDeliveryPricingUsecase = deliveryInstances.getDeliveryPricingUsecase;
export const geocodeRestaurantUsecase = deliveryInstances.geocodeRestaurantUsecase;

// store-settings
export const getStoreSettingsUsecase = storeSettingsInstances.getStoreSettingsUsecase;
export const updateStoreSettingsUsecase = storeSettingsInstances.updateStoreSettingsUsecase;
export const saveStoreLogoUsecase = storeSettingsInstances.saveStoreLogoUsecase;
export const clearStoreLogoUsecase = storeSettingsInstances.clearStoreLogoUsecase;

// customer
export const listCustomersUsecase = customerInstances.listCustomersUsecase;
export const getCustomerDetailUsecase = customerInstances.getCustomerDetailUsecase;
export const createCustomerUsecase = customerInstances.createCustomerUsecase;
export const updateCustomerUsecase = customerInstances.updateCustomerUsecase;
export const searchCustomersUsecase = customerInstances.searchCustomersUsecase;
export const saveCustomerPhotoUsecase = customerInstances.saveCustomerPhotoUsecase;
export const clearCustomerPhotoUsecase = customerInstances.clearCustomerPhotoUsecase;
export const listCustomerOrdersUsecase = customerInstances.listCustomerOrdersUsecase;
export const customerSummaryUsecase = customerInstances.customerSummaryUsecase;

// getSettings — legado (o port StoreSettingsReader é o caminho novo)
export const getSettings = () => new PostgresStoreSettingsReader().get();
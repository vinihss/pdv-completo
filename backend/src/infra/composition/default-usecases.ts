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
import { createProductUsecases } from "../../application/product/product.usecases.js";
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
import { createCashFlowUsecases } from "../../application/cash-flow/cash-flow.usecases.js";
import { createReportUsecases } from "../../application/report.usecases.js";
import { createOverviewReportUsecases } from "../../application/report-overview.usecases.js";
import { createDeliveriesReportUsecases } from "../../application/report-deliveries.usecases.js";
import { createPurchaseUsecases } from "../../application/purchase/purchase.usecases.js";
import { createRefundUsecases } from "../../application/refund/refund.usecases.js";
import { createProvisioningUsecases } from "../../application/provisioning/provisioning.usecases.js";
import { createProvisioningEmailUsecases } from "../../application/provisioning/provisioning-email.usecase.js";
import { createTenantUsecases } from "../../application/tenant/resolve-tenant.usecase.js";
import { createUserUsecases } from "../../application/user.usecases.js";
import { createLoginUsecase } from "../../application/auth/login.usecase.js";
import { TenantRegistryAdapter } from "../db/tenant-registry-adapter.js";
import { PublicTenantBrandReaderAdapter } from "../db/public-tenant-brand-reader.js";
import { TenantScopeAdapter } from "../db/tenant-scope-adapter.js";
import { invalidateActiveUser } from "../auth/active-user-check.js";
import { MailerPortAdapter } from "../mail/mailer-port-adapter.js";
import { resolveTenantSchema } from "../storage/index.js";
import { config } from "../../config/env.js";
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
// então usamos o explicit com fallback env.
//
// A raiz TEM que ser a mesma que a rota de serving usa (`getStorage()` →
// `createStorage(config.uploadsDir)`): com dois defaults distintos
// (`/tmp/uploads` aqui e `"uploads"` em `config`), o use case gravava num
// diretório e o `GET /uploads/*` lia de outro — 404 em todo arquivo recém
// enviado. `config.uploadsDir` é a fonte única.
const storageRoot = config.uploadsDir;
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

// Equipe (Onda auth): CRUD de usuários + PIN + foto. A `invalidateActiveUser`
// é o efeito de infra que o use case dispara na cascata de desativação
// (docs/21 §5.4) — o cache de 30s do middleware não pode mentir depois de um
// toggle explícito.
const userInstances = createUserUsecases({
  uow,
  tenant,
  storage,
  invalidateActiveUser,
});

// Relatórios gerenciais (Onda 3D) — leituras via `session.reports` na janela
// `uow.run`, cache `reports:*` via o mesmo `alsTenantCache` (prefixo por schema).
const reportInstances = createReportUsecases({ uow, tenant, cache });
const overviewReportInstances = createOverviewReportUsecases({ uow, tenant, cache });
const deliveriesReportInstances = createDeliveriesReportUsecases({ uow, tenant, cache });

// Financeiro (Onda financeiro) — compras/fornecedores e estornos do balcão
// (Bloco 4). Factories puras (uow + tenant).
const purchaseInstances = createPurchaseUsecases({ uow, tenant });
const refundInstances = createRefundUsecases({ uow, tenant });

// Fluxo de caixa / gaveta (Onda cash-flow) — factory pura (uow + tenant): toda
// a persistência (gaveta, movimentos, resumo) passa pelos ports de sessão e
// audit/outbox saem na MESMA transação.
const cashFlowInstances = createCashFlowUsecases({ uow, tenant });

// Device provisioning (docs/21) + resolução de tenant (docs/15). O
// `assertDeviceForLogin` é consumido pelo `login.usecase`; o `resolveTenant` é
// consumido pelo `server.ts`, pelo middleware de tenant e pelo próprio login
// (fallback de host quando o ALS está vazio). O `jwtSecret` é injetado (a
// `application` não lê `config`).
const provisioningInstances = createProvisioningUsecases({
  uow,
  tenant,
  jwtSecret: config.jwtSecret,
});
const provisioningEmailInstances = createProvisioningEmailUsecases({
  uow,
  tenant,
  mailer: new MailerPortAdapter(),
  generateProvisioningKey: provisioningInstances.generateProvisioningKeyUsecase,
});
const tenantInstances = createTenantUsecases({
  registry: new TenantRegistryAdapter(),
  defaultSchema: resolveTenantSchema,
  publicBrand: new PublicTenantBrandReaderAdapter(),
});

// Login por PIN (Onda auth): a factory recebe o escopo de tenant (ALS), a
// resolução por host e a validação do aparelho provisionado — antes o use case
// importava o composition root e `config`; agora tudo entra por `deps`.
const loginInstances = createLoginUsecase({
  uow,
  tenant,
  scope: new TenantScopeAdapter(),
  resolveTenant: tenantInstances.resolveTenant,
  assertDeviceForLogin: provisioningInstances.assertDeviceForLogin,
  jwtSecret: config.jwtSecret,
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

// equipe / usuários (Onda auth)
export const listUsersUsecase = userInstances.listUsersUsecase;
export const createUserUsecase = userInstances.createUserUsecase;
export const updateUserUsecase = userInstances.updateUserUsecase;
export const getOwnProfileUsecase = userInstances.getOwnProfileUsecase;
export const updateOwnProfileUsecase = userInstances.updateOwnProfileUsecase;
export const resetPinUsecase = userInstances.resetPinUsecase;
export const saveUserPhotoUsecase = userInstances.saveUserPhotoUsecase;
export const clearUserPhotoUsecase = userInstances.clearUserPhotoUsecase;
export const listActiveUsersUsecase = userInstances.listActiveUsersUsecase;

// relatórios gerenciais (report, report-overview, report-deliveries)
export const salesReportUsecase = reportInstances.salesReportUsecase;
export const overviewReportUsecase = overviewReportInstances.overviewReportUsecase;
export const deliveriesReportUsecase = deliveriesReportInstances.deliveriesReportUsecase;

// compras/fornecedores + valorização do estoque (Onda financeiro)
export const listSuppliersUsecase = purchaseInstances.listSuppliersUsecase;
export const createSupplierUsecase = purchaseInstances.createSupplierUsecase;
export const updateSupplierUsecase = purchaseInstances.updateSupplierUsecase;
export const createPurchaseUsecase = purchaseInstances.createPurchaseUsecase;
export const listPurchasesUsecase = purchaseInstances.listPurchasesUsecase;
export const getPurchaseUsecase = purchaseInstances.getPurchaseUsecase;
export const inventoryValuationUsecase = purchaseInstances.inventoryValuationUsecase;
export const averageCostOf = purchaseInstances.averageCostOf;

// estornos do balcão (Bloco 4 — Onda financeiro)
export const refundOrderPaymentUsecase = refundInstances.refundOrderPaymentUsecase;
export const listOrderRefundsUsecase = refundInstances.listOrderRefundsUsecase;

// fluxo de caixa / gaveta (Onda cash-flow)
export const getCurrentDrawerUsecase = cashFlowInstances.getCurrentDrawerUsecase;
export const listCashDrawersUsecase = cashFlowInstances.listCashDrawersUsecase;
export const getCashDrawerDetailUsecase = cashFlowInstances.getCashDrawerDetailUsecase;
export const sumCashDrawersSummaryUsecase = cashFlowInstances.sumCashDrawersSummaryUsecase;
export const openCashDrawerUsecase = cashFlowInstances.openCashDrawerUsecase;
export const registerCashMovementUsecase = cashFlowInstances.registerCashMovementUsecase;
export const closeCashDrawerUsecase = cashFlowInstances.closeCashDrawerUsecase;

// getSettings — legado (o port StoreSettingsReader é o caminho novo)
export const getSettings = () => new PostgresStoreSettingsReader().get();

// device provisioning (docs/21)
export const generateProvisioningKeyUsecase = provisioningInstances.generateProvisioningKeyUsecase;
export const exchangeProvisioningCodeUsecase = provisioningInstances.exchangeProvisioningCodeUsecase;
export const refreshDeviceSessionUsecase = provisioningInstances.refreshDeviceSessionUsecase;
export const assertDeviceForLogin = provisioningInstances.assertDeviceForLogin;
export const listUserDevicesUsecase = provisioningInstances.listUserDevicesUsecase;
export const revokeDeviceUsecase = provisioningInstances.revokeDeviceUsecase;
export const sendProvisioningEmailUsecase = provisioningEmailInstances.sendProvisioningEmailUsecase;
export const resendProvisioningEmailUsecase = provisioningEmailInstances.resendProvisioningEmailUsecase;

// login por PIN (Onda auth)
export const loginUsecase = loginInstances.loginUsecase;

// resolução de tenant (docs/15)
export const resolveTenant = tenantInstances.resolveTenant;
export const getPublicTenantUsecase = tenantInstances.getPublicTenantUsecase;
export { DEFAULT_TENANT_SLUG, tenantRoutingEnabled } from "../../application/tenant/resolve-tenant.usecase.js";
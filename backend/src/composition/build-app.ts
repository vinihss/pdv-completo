/**
 * Composition root definitiva — ONDA 7.
 *
 * Único ponto que conhece adapters concretos. Monta os containers de use
 * cases por domínio (`buildContainer`) e expõe o `buildApp()` (saindo de
 * `http/server.ts`, que antes registrava tudo inline).
 *
 * O refactor http (onda 7a) já havia movido o registro das rotas para
 * `http/plugins/router.plugin.ts`; aqui elas finalmente recebem as
 * dependências por parâmetro — nenhuma rota importa adapters ou o root
 * de composição.
 */
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import fastifyMultipart from "@fastify/multipart";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config/env.js";
import { runMigrations } from "../infra/db/migrate.js";
import { runRegistryMigrations } from "../infra/db/registry-migrate.js";
import { checkDatabaseHealth } from "../infra/db/client.js";
import { getTenantPool } from "../infra/db/tenant-db.js";
import { resolveTenantSchemaInScope, ensureTenantScope } from "../infra/db/tenant-context.js";
import { startOutboxDispatcher } from "../infra/realtime/outbox-dispatcher.js";
import { startMaintenanceJobs } from "../infra/maintenance.js";
import { initStorage, resolveTenantSchema } from "../infra/storage/index.js";
import { initCache } from "../infra/cache/index.js";
import { listActiveTenants } from "../infra/tenant/registry.js";
import { currentTenantScope } from "../infra/db/tenant-context.js";
import { PostgresTenantUnitOfWork } from "../infra/db/postgres-tenant-unit-of-work.js";
import { createPostgresTenantSession } from "../infra/db/postgres-session.js";
import { TenantCacheAdapter, alsTenantCache } from "../infra/cache/tenant-cache-adapter.js";
import { StoragePortAdapter } from "../infra/storage/storage-port-adapter.js";
import { PostgresStoreSettingsReader } from "../infra/db/store-settings-reader.js";
import { OrderPrinterAdapter } from "../integrations/printer/order-printer-adapter.js";
import { GeocodingPortAdapter } from "../integrations/maps/geocoding-port-adapter.js";
import { RoutingPortAdapter } from "../integrations/maps/routing-port-adapter.js";
import { createOrderUsecases } from "../application/order/order.usecases.js";
import { createAlertUsecases } from "../application/alert/alert.usecases.js";
import { createStockUsecases } from "../application/stock/stock.usecases.js";
import { createProductUsecases } from "../application/product/product.usecases.js";
import { createCategoryUsecases } from "../application/category/category.usecases.js";
import { createKitchenGroupUsecases } from "../application/kitchen-group/kitchen-group.usecases.js";
import { createMenuUsecases } from "../application/self-service/menu.usecases.js";
import { createCartUsecases } from "../application/self-service/cart.usecases.js";
import { createCustomerAddressUsecases } from "../application/self-service/customer-address.usecases.js";
import { createSelfServiceCancelUsecases } from "../application/self-service/cancel-order.usecase.js";
import {
  createCloseOrderAfterDelivery,
  createManagerDeliveryStatusUsecases,
} from "../application/self-service/manager-delivery-status.usecase.js";
import { createSelfServiceDeliveryUsecases } from "../application/self-service/delivery.usecases.js";
import { createOrderIntakeUsecases } from "../application/self-service/order-intake.usecase.js";
import { createAuditLogUsecases } from "../application/audit-log/audit-log.usecases.js";
import { createDeliveryUsecases } from "../application/delivery/calcular-entrega.usecase.js";
import { createStoreSettingsUsecases } from "../application/store-settings/store-settings.usecases.js";
import { createCustomerUsecases } from "../application/customer/customer.usecases.js";
import {
  createReportUsecases,
  createOverviewReportUsecases,
  createDeliveriesReportUsecases,
} from "../application/report/report.usecases.js";
import { createPurchaseUsecases } from "../application/purchase/purchase.usecases.js";
import { createRefundUsecases } from "../application/refund/refund.usecases.js";
import { createProvisioningUsecases } from "../application/provisioning/provisioning.usecases.js";
import { createProvisioningEmailUsecases } from "../application/provisioning/provisioning-email.usecase.js";
import { createTenantUsecases } from "../application/tenant/resolve-tenant.usecase.js";
import { createUserUsecases } from "../application/user/user.usecases.js";
import { createLoginUsecase } from "../application/auth/login.usecase.js";
import { createCashFlowUsecases } from "../application/cash-flow/cash-flow.usecases.js";

import { TenantRegistryAdapter } from "../infra/db/tenant-registry-adapter.js";
import { PublicTenantBrandReaderAdapter } from "../infra/db/public-tenant-brand-reader.js";
import { TenantScopeAdapter } from "../infra/db/tenant-scope-adapter.js";
import { invalidateActiveUser } from "../infra/auth/active-user-check.js";
import { MailerPortAdapter } from "../infra/mail/mailer-port-adapter.js";
import { getCache } from "../infra/cache/index.js";

import type { TenantContext } from "../application/ports/tenant-context.js";
import type { GeocodingService, RoutingService } from "../application/ports/effects.js";
import type { RoutesDeps } from "./routes-deps.js";

import { tenantContext } from "../http/plugins/tenant-context.plugin.js";
import { appRouter } from "../http/plugins/router.plugin.js";
import { configureGlobalErrorHandler } from "../http/errors/error-handler.js";

// ---------------------------------------------------------------------------
// Tenant resolver: lê o ALS (contexto do request/worker corrente) e monta o
// TenantContext. É a única dependência de ALS nesta composição — os use cases
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
// Contexto delivery — geocoding/roteamento como SEAM de teste
// ---------------------------------------------------------------------------
// `setMapServices` preserva a semântica do antigo (módulo `calcular-entrega`):
// troca as implementações usadas pelo contexto delivery. A troca é feita nas
// referências que os adapters-delegate capturaram no wiring abaixo — as
// chamadas seguintes enxergam a nova implementação.
let geocodingService: GeocodingService = new GeocodingPortAdapter();
let routingService: RoutingService = new RoutingPortAdapter();

export function setMapServices(geocoding: GeocodingService, routing: RoutingService): void {
  geocodingService = geocoding;
  routingService = routing;
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

// O cache do hub de pedidos é no-op hoje: a lista e o detalhe leem do banco
// (o pedido tem lock otimista próprio). O `TenantCacheAdapter` importado aqui
// só existe para o type do port.
void TenantCacheAdapter;

// ---------------------------------------------------------------------------
// buildContainer: instancia as factories de use case com os adapters acima e
// monta os containers por domínio (`RoutesDeps`). Deve ser chamado no boot
// (em `buildApp`) e nos testes que montam um app Fastify próprio.
// ---------------------------------------------------------------------------
export function buildContainer(): RoutesDeps {
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
  // fechamento da comanda pós-entrega é composto UMA vez e injetado nos dois
  // use cases que concluem entrega (entregador e gerente), evitando duas
  // cópias divergindo.
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
  // (docs/21 §5.4) — o cache de 30s do middleware não pode mentir depois de
  // um toggle explícito.
  const userInstances = createUserUsecases({
    uow,
    tenant,
    storage,
    invalidateActiveUser,
  });

  // Relatórios gerenciais (Onda 3D) — leituras via `session.reports` na janela
  // `uow.run`, cache `reports:*` via o mesmo `alsTenantCache` (prefixo por
  // schema).
  const reportInstances = createReportUsecases({ uow, tenant, cache });
  const overviewReportInstances = createOverviewReportUsecases({ uow, tenant, cache });
  const deliveriesReportInstances = createDeliveriesReportUsecases({ uow, tenant, cache });

  // Financeiro (Onda financeiro) — compras/fornecedores e estornos do balcão
  // (Bloco 4). Factories puras (uow + tenant).
  const purchaseInstances = createPurchaseUsecases({ uow, tenant });
  const refundInstances = createRefundUsecases({ uow, tenant });

  // Fluxo de caixa / gaveta (Onda cash-flow) — factory pura (uow + tenant):
  // toda a persistência (gaveta, movimentos, resumo) passa pelos ports de
  // sessão e audit/outbox saem na MESMA transação.
  const cashFlowInstances = createCashFlowUsecases({ uow, tenant });

  // Device provisioning (docs/21) + resolução de tenant (docs/15). O
  // `assertDeviceForLogin` é consumido pelo `login.usecase`; o `resolveTenant`
  // é consumido pelo middleware de tenant e pelo próprio login (fallback de
  // host quando o ALS está vazio). O `jwtSecret` é injetado (a `application`
  // não lê `config`).
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
  // resolução por host e a validação do aparelho provisionado — antes o use
  // case importava o composition root e `config`; agora tudo entra por `deps`.
  const loginInstances = createLoginUsecase({
    uow,
    tenant,
    scope: new TenantScopeAdapter(),
    resolveTenant: tenantInstances.resolveTenant,
    assertDeviceForLogin: provisioningInstances.assertDeviceForLogin,
    jwtSecret: config.jwtSecret,
  });

  // -------------------------------------------------------------------------
  // Namespaces por domínio (`RoutesDeps`) — o que cada rota recebe
  // -------------------------------------------------------------------------
  return {
    order: {
      openOrderUsecase: orderInstances.openOrderUsecase,
      addItemsUsecase: orderInstances.addItemsUsecase,
      updateItemStatusUsecase: orderInstances.updateItemStatusUsecase,
      deleteItemUsecase: orderInstances.deleteItemUsecase,
      setOrderPaymentsUsecase: orderInstances.setOrderPaymentsUsecase,
      confirmOrderPaymentUsecase: orderInstances.confirmOrderPaymentUsecase,
      deleteOrderPaymentUsecase: orderInstances.deleteOrderPaymentUsecase,
      registerPaymentUsecase: orderInstances.registerPaymentUsecase,
      closeOrderUsecase: orderInstances.closeOrderUsecase,
      cancelOrderUsecase: orderInstances.cancelOrderUsecase,
      getOrderUsecase: orderInstances.getOrderUsecase,
      listOrdersUsecase: orderInstances.listOrdersUsecase,
      listTablesUsecase: orderInstances.listTablesUsecase,
    },
    alert: {
      listAlertsUsecase: alertInstances.listAlertsUsecase,
      markAlertsReadUsecase: alertInstances.markAlertsReadUsecase,
    },
    auditLog: {
      listAuditLogUsecase: auditLogInstances.listAuditLogUsecase,
    },
    auth: {
      loginUsecase: loginInstances.loginUsecase,
      listActiveUsersUsecase: userInstances.listActiveUsersUsecase,
      getOwnProfileUsecase: userInstances.getOwnProfileUsecase,
      updateOwnProfileUsecase: userInstances.updateOwnProfileUsecase,
      saveUserPhotoUsecase: userInstances.saveUserPhotoUsecase,
      clearUserPhotoUsecase: userInstances.clearUserPhotoUsecase,
    },
    cashFlow: {
      getCurrentDrawerUsecase: cashFlowInstances.getCurrentDrawerUsecase,
      listCashDrawersUsecase: cashFlowInstances.listCashDrawersUsecase,
      getCashDrawerDetailUsecase: cashFlowInstances.getCashDrawerDetailUsecase,
      sumCashDrawersSummaryUsecase: cashFlowInstances.sumCashDrawersSummaryUsecase,
      openCashDrawerUsecase: cashFlowInstances.openCashDrawerUsecase,
      registerCashMovementUsecase: cashFlowInstances.registerCashMovementUsecase,
      closeCashDrawerUsecase: cashFlowInstances.closeCashDrawerUsecase,
    },
    catalog: {
      listProductsUsecase: productInstances.listProductsUsecase,
      createProductUsecase: productInstances.createProductUsecase,
      updateProductUsecase: productInstances.updateProductUsecase,
      setProductActiveUsecase: productInstances.setProductActiveUsecase,
      saveProductImageUsecase: productInstances.saveProductImageUsecase,
      clearProductImageUsecase: productInstances.clearProductImageUsecase,
      listCategoriesUsecase: categoryInstances.listCategoriesUsecase,
      createCategoryUsecase: categoryInstances.createCategoryUsecase,
      updateCategoryUsecase: categoryInstances.updateCategoryUsecase,
      deleteCategoryUsecase: categoryInstances.deleteCategoryUsecase,
      listKitchenGroupsUsecase: kitchenGroupInstances.listKitchenGroupsUsecase,
      createKitchenGroupUsecase: kitchenGroupInstances.createKitchenGroupUsecase,
      updateKitchenGroupUsecase: kitchenGroupInstances.updateKitchenGroupUsecase,
      deleteKitchenGroupUsecase: kitchenGroupInstances.deleteKitchenGroupUsecase,
      getPublicMenuUsecase: menuInstances.getPublicMenuUsecase,
    },
    selfService: {
      getPublicMenuUsecase: menuInstances.getPublicMenuUsecase,
      calcularEntregaUsecase: deliveryInstances.calcularEntregaUsecase,
      getDeliveryPricingUsecase: deliveryInstances.getDeliveryPricingUsecase,
      lookupCustomerByPhoneUsecase: customerAddressInstances.lookupCustomerByPhoneUsecase,
      createSelfServiceCustomerUsecase: customerAddressInstances.createSelfServiceCustomerUsecase,
      addCustomerAddressUsecase: customerAddressInstances.addCustomerAddressUsecase,
      listCustomerAddressesUsecase: customerAddressInstances.listCustomerAddressesUsecase,
      setDefaultCustomerAddressUsecase: customerAddressInstances.setDefaultCustomerAddressUsecase,
      deleteCustomerAddressUsecase: customerAddressInstances.deleteCustomerAddressUsecase,
      cancelSelfServiceOrderUsecase: selfServiceCancelInstances.cancelSelfServiceOrderUsecase,
      getCustomerCartUsecase: cartInstances.getCustomerCartUsecase,
      saveCustomerCartUsecase: cartInstances.saveCustomerCartUsecase,
      clearCustomerCartUsecase: cartInstances.clearCustomerCartUsecase,
      createSelfServiceOrderUsecase: orderIntakeInstances.createSelfServiceOrderUsecase,
      getSelfServiceOrderStatusUsecase: orderIntakeInstances.getSelfServiceOrderStatusUsecase,
      getActiveSelfServiceOrderByPhoneUsecase:
        orderIntakeInstances.getActiveSelfServiceOrderByPhoneUsecase,
      listCourierDeliveriesUsecase: selfServiceDeliveryInstances.listCourierDeliveriesUsecase,
      dispatchDeliveryUsecase: selfServiceDeliveryInstances.dispatchDeliveryUsecase,
      deliverDeliveryUsecase: selfServiceDeliveryInstances.deliverDeliveryUsecase,
      failDeliveryUsecase: selfServiceDeliveryInstances.failDeliveryUsecase,
      reportCourierLocationUsecase: selfServiceDeliveryInstances.reportCourierLocationUsecase,
      listCourierLocationsUsecase: selfServiceDeliveryInstances.listCourierLocationsUsecase,
      listCouriersUsecase: selfServiceDeliveryInstances.listCouriersUsecase,
      listManagerDeliveriesUsecase: selfServiceDeliveryInstances.listManagerDeliveriesUsecase,
      assignCourierUsecase: selfServiceDeliveryInstances.assignCourierUsecase,
      setDeliveryStatusUsecase: managerDeliveryStatusInstances.setDeliveryStatusUsecase,
      geocodeRestaurantUsecase: deliveryInstances.geocodeRestaurantUsecase,
    },
    customer: {
      listCustomersUsecase: customerInstances.listCustomersUsecase,
      getCustomerDetailUsecase: customerInstances.getCustomerDetailUsecase,
      createCustomerUsecase: customerInstances.createCustomerUsecase,
      updateCustomerUsecase: customerInstances.updateCustomerUsecase,
      searchCustomersUsecase: customerInstances.searchCustomersUsecase,
      saveCustomerPhotoUsecase: customerInstances.saveCustomerPhotoUsecase,
      clearCustomerPhotoUsecase: customerInstances.clearCustomerPhotoUsecase,
      listCustomerOrdersUsecase: customerInstances.listCustomerOrdersUsecase,
      customerSummaryUsecase: customerInstances.customerSummaryUsecase,
      addCustomerAddressUsecase: customerAddressInstances.addCustomerAddressUsecase,
      setDefaultCustomerAddressUsecase: customerAddressInstances.setDefaultCustomerAddressUsecase,
      deleteCustomerAddressUsecase: customerAddressInstances.deleteCustomerAddressUsecase,
      lookupCustomerByPhoneUsecase: customerAddressInstances.lookupCustomerByPhoneUsecase,
      createSelfServiceCustomerUsecase: customerAddressInstances.createSelfServiceCustomerUsecase,
      listCustomerAddressesUsecase: customerAddressInstances.listCustomerAddressesUsecase,
      listCourierDeliveriesUsecase: selfServiceDeliveryInstances.listCourierDeliveriesUsecase,
      dispatchDeliveryUsecase: selfServiceDeliveryInstances.dispatchDeliveryUsecase,
      deliverDeliveryUsecase: selfServiceDeliveryInstances.deliverDeliveryUsecase,
      failDeliveryUsecase: selfServiceDeliveryInstances.failDeliveryUsecase,
      reportCourierLocationUsecase: selfServiceDeliveryInstances.reportCourierLocationUsecase,
      listCourierLocationsUsecase: selfServiceDeliveryInstances.listCourierLocationsUsecase,
      listCouriersUsecase: selfServiceDeliveryInstances.listCouriersUsecase,
      listManagerDeliveriesUsecase: selfServiceDeliveryInstances.listManagerDeliveriesUsecase,
      assignCourierUsecase: selfServiceDeliveryInstances.assignCourierUsecase,
      setDeliveryStatusUsecase: managerDeliveryStatusInstances.setDeliveryStatusUsecase,
    },
    user: {
      listUsersUsecase: userInstances.listUsersUsecase,
      createUserUsecase: userInstances.createUserUsecase,
      updateUserUsecase: userInstances.updateUserUsecase,
      getOwnProfileUsecase: userInstances.getOwnProfileUsecase,
      updateOwnProfileUsecase: userInstances.updateOwnProfileUsecase,
      resetPinUsecase: userInstances.resetPinUsecase,
      saveUserPhotoUsecase: userInstances.saveUserPhotoUsecase,
      clearUserPhotoUsecase: userInstances.clearUserPhotoUsecase,
      listActiveUsersUsecase: userInstances.listActiveUsersUsecase,
    },
    storeSettings: {
      getStoreSettingsUsecase: storeSettingsInstances.getStoreSettingsUsecase,
      updateStoreSettingsUsecase: storeSettingsInstances.updateStoreSettingsUsecase,
      saveStoreLogoUsecase: storeSettingsInstances.saveStoreLogoUsecase,
      clearStoreLogoUsecase: storeSettingsInstances.clearStoreLogoUsecase,
      geocodeRestaurantUsecase: deliveryInstances.geocodeRestaurantUsecase,
    },
    reports: {
      salesReportUsecase: reportInstances.salesReportUsecase,
      overviewReportUsecase: overviewReportInstances.overviewReportUsecase,
      deliveriesReportUsecase: deliveriesReportInstances.deliveriesReportUsecase,
    },
    finance: {
      listSuppliersUsecase: purchaseInstances.listSuppliersUsecase,
      createSupplierUsecase: purchaseInstances.createSupplierUsecase,
      updateSupplierUsecase: purchaseInstances.updateSupplierUsecase,
      createPurchaseUsecase: purchaseInstances.createPurchaseUsecase,
      listPurchasesUsecase: purchaseInstances.listPurchasesUsecase,
      getPurchaseUsecase: purchaseInstances.getPurchaseUsecase,
      inventoryValuationUsecase: purchaseInstances.inventoryValuationUsecase,
      averageCostOf: purchaseInstances.averageCostOf,
      refundOrderPaymentUsecase: refundInstances.refundOrderPaymentUsecase,
      listOrderRefundsUsecase: refundInstances.listOrderRefundsUsecase,
    },
    stock: {
      listStockUsecase: stockInstances.listStockUsecase,
      getStockMovementsUsecase: stockInstances.getStockMovementsUsecase,
      registerStockMovementUsecase: stockInstances.registerStockMovementUsecase,
      inventoryValuationUsecase: purchaseInstances.inventoryValuationUsecase,
    },
    provisioning: {
      generateProvisioningKeyUsecase: provisioningInstances.generateProvisioningKeyUsecase,
      exchangeProvisioningCodeUsecase: provisioningInstances.exchangeProvisioningCodeUsecase,
      refreshDeviceSessionUsecase: provisioningInstances.refreshDeviceSessionUsecase,
      revokeDeviceUsecase: provisioningInstances.revokeDeviceUsecase,
      listUserDevicesUsecase: provisioningInstances.listUserDevicesUsecase,
      assertDeviceForLogin: provisioningInstances.assertDeviceForLogin,
      sendProvisioningEmailUsecase: provisioningEmailInstances.sendProvisioningEmailUsecase,
      resendProvisioningEmailUsecase: provisioningEmailInstances.resendProvisioningEmailUsecase,
    },
    tenant: {
      getPublicTenantUsecase: tenantInstances.getPublicTenantUsecase,
      resolveTenant: tenantInstances.resolveTenant,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// buildApp — monta o Fastify completo (plugs, middleware de tenant, health,
// roteador com deps injetadas). Substitui o `buildApp` que vivia em
// `http/server.ts` e o registro inline de rotas.
// ---------------------------------------------------------------------------
export async function buildApp(): Promise<FastifyInstance> {
  const container = buildContainer();
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });

  // 1. Camada de Cache
  await initCache(true);
  app.decorate("cache", getCache() as any);

  // 2. Manipulação de Erros Global
  configureGlobalErrorHandler(app);

  // 3. Plugins Corporativos e Segurança
  await app.register(cors, {
    origin: config.corsOrigin
      ? config.corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)
      : true,
  });
  await app.register(websocketPlugin);
  await app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // 4. Inicialização do Contexto do Tenant (ordem importa antes das rotas)
  await app.register(tenantContext, { resolveTenant: container.tenant.resolveTenant });

  // 5. Inicialização do Storage e Rotas Internas Core
  initStorage();

  app.get("/health", async (_req, reply) => {
    const healthy = await checkDatabaseHealth();
    return healthy
      ? reply.code(200).send({ status: "ok", database: "connected", tag: process.env.APP_TAG ?? "" })
      : reply.code(503).send({ status: "degraded", database: "disconnected" });
  });

  app.get("/health/detailed", async (_req, reply) => {
    if (!(await checkDatabaseHealth())) return reply.code(503).send({ status: "degraded", database: "disconnected" });
    try {
      const schemaName = resolveTenantSchemaInScope();
      const pool = getTenantPool(schemaName);
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ name: string; applied_at: string }>("SELECT name, applied_at FROM _migrations ORDER BY name");
        return reply.code(200).send({
          status: "ok", database: "connected", schema: schemaName, tag: process.env.APP_TAG ?? "",
          migrations: { total: rows.length, applied: rows.map((r) => ({ name: r.name, appliedAt: r.applied_at })) },
        });
      } finally {
        client.release();
      }
    } catch (err) {
      return reply.code(500).send({ status: "error", database: "connected", error: (err as Error).message });
    }
  });

  app.get("/internal/caddy-on-demand-tls", async (req, reply) => {
    const domain = String((req.query as Record<string, unknown>)?.domain ?? "").toLowerCase();
    const root = (process.env.PLATFORM_ROOT_DOMAIN?.trim() || "umamisushiarte.com.br").toLowerCase();
    const ok = new RegExp(`^[a-z0-9-]+\\.(labolabe\\.tech|${escapeRegExp(root)})$`).test(domain);
    return reply.code(ok ? 204 : 403).send();
  });

  // 6. Registro Centralizado de Rotas do App (deps injetadas por parâmetro)
  await app.register(appRouter, { container });

  // 7. Store Info Pública Isolada
  app.get("/store-info", async (req, reply) => {
    const host = (req.headers["x-tenant-host"] as string) || req.headers.host;
    return ensureTenantScope(host, async () => {
      const s = await container.storeSettings.getStoreSettingsUsecase();
      return {
        merchantName: s.merchantName,
        merchantCity: s.merchantCity,
        logoUrl: s.logoUrl,
        brandColor: s.brandColor,
        usesDelivery: s.usesDelivery,
        deliveryFee: s.deliveryFee,
        deliveryFeeTiers: s.deliveryFeeTiers,
        deliveryPrepMinutes: s.deliveryPrepMinutes,
        minutesPerKm: s.minutesPerKm,
        enabledPaymentMethods: s.enabledPaymentMethods,
      };
    });
  });

  return app;
}

async function main() {
  if (config.deploymentMode === "local") {
    try {
      await runRegistryMigrations();
      await runMigrations();
      for (const tenant of await listActiveTenants()) {
        if (tenant.schemaName === resolveTenantSchema()) continue;
        await runMigrations({ schema: tenant.schemaName });
      }
    } catch (err) {
      throw new Error(`[boot] migrations falharam: ${(err as Error).message}`, { cause: err });
    }
  }

  const app = await buildApp();
  const stopDispatcher = startOutboxDispatcher();
  const stopMaintenance = startMaintenanceJobs();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`PDV backend rodando em modo ${config.deploymentMode} na porta ${config.port}`);

  const shutdown = async () => {
    stopDispatcher();
    stopMaintenance();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const stripExt = (p: string) => path.resolve(p).replace(/\.(js|mjs|cjs|ts|mts|cts)$/, "");
  return stripExt(entry) === stripExt(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

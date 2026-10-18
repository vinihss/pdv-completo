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
import { createCategoryUsecases } from "../../application/category/category.usecases.js";
import { createKitchenGroupUsecases } from "../../application/kitchen-group/kitchen-group.usecases.js";
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
import { createAuditLogUsecases } from "../../application/audit-log/audit-log.usecases.js";
import { createDeliveryUsecases } from "../../application/delivery/calcular-entrega.usecase.js";
import { createStoreSettingsUsecases } from "../../application/store-settings/store-settings.usecases.js";
import { createCustomerUsecases } from "../../application/customer/customer.usecases.js";
import { createCashFlowUsecases } from "../../application/cash-flow/cash-flow.usecases.js";
import {
  createReportUsecases,
  createOverviewReportUsecases,
  createDeliveriesReportUsecases,
} from "../../application/report/report.usecases.js";
import { createPurchaseUsecases } from "../../application/purchase/purchase.usecases.js";
import { createRefundUsecases } from "../../application/refund/refund.usecases.js";
import { createProvisioningUsecases } from "../../application/provisioning/provisioning.usecases.js";
import { createProvisioningEmailUsecases } from "../../application/provisioning/provisioning-email.usecase.js";
import { createTenantUsecases, tenantRoutingEnabled } from "../../application/tenant/resolve-tenant.usecase.js";
import { createUserUsecases } from "../../application/user/user.usecases.js";
import { createLoginUsecase } from "../../application/auth/login.usecase.js";
import { createIdentityUsecases } from "../../application/identity/identity.usecases.js";
import { TenantRegistryAdapter } from "../db/tenant-registry-adapter.js";
import { PublicTenantBrandReaderAdapter } from "../db/public-tenant-brand-reader.js";
import { PgIdentityTenantReader } from "../db/identity-tenant-reader.js";
import { TenantScopeAdapter } from "../db/tenant-scope-adapter.js";
import { invalidateActiveUser } from "../auth/active-user-check.js";
import { MailerPortAdapter } from "../mail/mailer-port-adapter.js";
import { listActiveTenants } from "../tenant/registry.js";
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
export const orderInstances = createOrderUsecases({
  uow,
  cache: { get: () => Promise.resolve(null), set: () => Promise.resolve(), invalidatePrefix: () => Promise.resolve() },
  printer: new OrderPrinterAdapter(),
  settings: new PostgresStoreSettingsReader(),
  tenant,
});

export const alertInstances = createAlertUsecases({ uow, tenant });

export const stockInstances = createStockUsecases({ uow, tenant });

export const productInstances = createProductUsecases({
  uow,
  cache,
  storage,
  tenant,
});

export const categoryInstances = createCategoryUsecases({
  uow,
  cache,
  tenant,
});

export const kitchenGroupInstances = createKitchenGroupUsecases({
  uow,
  cache,
  tenant,
});

export const menuInstances = createMenuUsecases({
  uow,
  tenant,
});

// Self-service: carrinho (customer_cart), endereços (customer_address) e
// cancelamento pelo cliente. O cancelamento reusa o hub de pedidos — a
// dependência é injetada, não importada.
export const cartInstances = createCartUsecases({ uow, tenant });
export const customerAddressInstances = createCustomerAddressUsecases({ uow, tenant });
export const selfServiceCancelInstances = createSelfServiceCancelUsecases({
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
export const selfServiceDeliveryInstances = createSelfServiceDeliveryUsecases({
  uow,
  tenant,
  settings: new PostgresStoreSettingsReader(),
  printer: new OrderPrinterAdapter(),
  closeOrderAfterDelivery,
});
export const managerDeliveryStatusInstances = createManagerDeliveryStatusUsecases({
  uow,
  tenant,
  settings: new PostgresStoreSettingsReader(),
  printer: new OrderPrinterAdapter(),
  closeOrderAfterDelivery,
});
export const orderIntakeInstances = createOrderIntakeUsecases({
  uow,
  tenant,
  settings: new PostgresStoreSettingsReader(),
  addCustomerAddress: customerAddressInstances.addCustomerAddressUsecase,
  openOrder: orderInstances.openOrderUsecase,
  addItems: orderInstances.addItemsUsecase,
  registerPayment: orderInstances.registerPaymentUsecase,
  getOrder: orderInstances.getOrderUsecase,
});

export const auditLogInstances = createAuditLogUsecases({ uow, tenant });

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

export const deliveryInstances = createDeliveryUsecases({
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
export const storeSettingsInstances = createStoreSettingsUsecases({
  uow,
  tenant,
  cache,
  storage,
  geocoding: {
    reverseGeocode: (coords) => geocodingService.reverseGeocode(coords),
    forwardGeocode: (address) => geocodingService.forwardGeocode(address),
  },
});

export const customerInstances = createCustomerUsecases({
  uow,
  tenant,
  storage,
});

// Equipe (Onda auth): CRUD de usuários + PIN + foto. A `invalidateActiveUser`
// é o efeito de infra que o use case dispara na cascata de desativação
// (docs/21 §5.4) — o cache de 30s do middleware não pode mentir depois de um
// toggle explícito.
export const userInstances = createUserUsecases({
  uow,
  tenant,
  storage,
  invalidateActiveUser,
  // Onda identidade: convite (`POST /users`) manda a senha temporária por email.
  mailer: new MailerPortAdapter(),
});

// Relatórios gerenciais (Onda 3D) — leituras via `session.reports` na janela
// `uow.run`, cache `reports:*` via o mesmo `alsTenantCache` (prefixo por schema).
export const reportInstances = createReportUsecases({ uow, tenant, cache });
export const overviewReportInstances = createOverviewReportUsecases({ uow, tenant, cache });
export const deliveriesReportInstances = createDeliveriesReportUsecases({ uow, tenant, cache });

// Financeiro (Onda financeiro) — compras/fornecedores e estornos do balcão
// (Bloco 4). Factories puras (uow + tenant).
export const purchaseInstances = createPurchaseUsecases({ uow, tenant });
export const refundInstances = createRefundUsecases({ uow, tenant });

// Fluxo de caixa / gaveta (Onda cash-flow) — factory pura (uow + tenant): toda
// a persistência (gaveta, movimentos, resumo) passa pelos ports de sessão e
// audit/outbox saem na MESMA transação.
export const cashFlowInstances = createCashFlowUsecases({ uow, tenant });

// Device provisioning (docs/21) + resolução de tenant (docs/15). O
// `assertDeviceForLogin` é consumido pelo `login.usecase`; o `resolveTenant` é
// consumido pelo `server.ts`, pelo middleware de tenant e pelo próprio login
// (fallback de host quando o ALS está vazio). O `jwtSecret` é injetado (a
// `application` não lê `config`).
export const provisioningInstances = createProvisioningUsecases({
  uow,
  tenant,
  jwtSecret: config.jwtSecret,
});
export const provisioningEmailInstances = createProvisioningEmailUsecases({
  uow,
  tenant,
  mailer: new MailerPortAdapter(),
  generateProvisioningKey: provisioningInstances.generateProvisioningKeyUsecase,
});
// Uma instância do registry para todos os consumidores (o cache de 60s é por
// chave no MemoryCache compartilhado, mas duas instâncias seriam duas fontes de
// verdade desnecessárias).
const tenantRegistry = new TenantRegistryAdapter();
export const tenantInstances = createTenantUsecases({
  registry: tenantRegistry,
  defaultSchema: resolveTenantSchema,
  publicBrand: new PublicTenantBrandReaderAdapter(),
});

// Login por PIN (Onda auth): a factory recebe o escopo de tenant (ALS), a
// resolução por host e a validação do aparelho provisionado — antes o use case
// importava o composition root e `config`; agora tudo entra por `deps`.
export const loginInstances = createLoginUsecase({
  uow,
  tenant,
  scope: new TenantScopeAdapter(),
  resolveTenant: tenantInstances.resolveTenant,
  assertDeviceForLogin: provisioningInstances.assertDeviceForLogin,
  jwtSecret: config.jwtSecret,
});

// Identidade centralizada (docs/26): login por email/senha, seleção de empresa,
// rotação de refresh, recuperação de senha e convite. O leitor por-tenant
// encapsula o ALS por schema (listagem de empresas + vínculo da conta); o
// `defaultTenant` vem do módulo de tenant para que "default" continue sendo uma
// decisão só (`DEFAULT_TENANT_SLUG` + `DEFAULT_TENANT_SCHEMA`).
export const identityInstances = createIdentityUsecases({
  uow,
  tenant,
  tenants: new PgIdentityTenantReader({
    brand: new PublicTenantBrandReaderAdapter(),
    registry: tenantRegistry,
    defaultTenant: tenantInstances.defaultTenant,
    routingEnabled: tenantRoutingEnabled,
    listActiveTenants,
  }),
  mailer: new MailerPortAdapter(),
  jwtSecret: config.jwtSecret,
});



// ---------------------------------------------------------------------------
// Compatibilidade mínima da composition root — encolhida na Onda 5.
// As rotas importam seus use cases via `../infra/composition/domains/*`.
// Este arquivo reexporta apenas o que ainda não tem consumidor recebendo
// deps por parâmetro (ratchet em test/composition-compat.test.ts).
// ---------------------------------------------------------------------------
export const getStoreSettingsUsecase = storeSettingsInstances.getStoreSettingsUsecase;
export const resolveTenant = tenantInstances.resolveTenant;
export { DEFAULT_TENANT_SLUG, tenantRoutingEnabled } from "../../application/tenant/resolve-tenant.usecase.js";

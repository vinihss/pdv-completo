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
import { CustomerNotifierAdapter } from "../../integrations/whatsapp/customer-notifier-adapter.js";
import { createOrderUsecases } from "../../application/order/order.usecases.js";
import { createAlertUsecases } from "../../application/alert/alert.usecases.js";
import { createStockUsecases } from "../../application/stock/stock.usecases.js";
import { createProductUsecases } from "../../application/product.usecases.js";
import { createCategoryUsecases } from "../../application/category.usecases.js";
import { createKitchenGroupUsecases } from "../../application/kitchen-group.usecases.js";
import { createMenuUsecases } from "../../application/self-service/menu.usecases.js";
import type { TenantContext } from "../../application/ports/tenant-context.js";

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
  notifier: new CustomerNotifierAdapter(),
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

// getSettings — legado (o port StoreSettingsReader é o caminho novo)
export const getSettings = () => new PostgresStoreSettingsReader().get();
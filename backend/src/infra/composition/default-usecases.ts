/**
 * Composition root provisória — ONDA 2.
 *
 * Liga os adapters concretos (Postgres, cache, impressão, notificação,
 * settings) às factories dos use cases migrados e exporta as funções com os
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
import { TenantCacheAdapter } from "../cache/tenant-cache-adapter.js";
import { createOrderNotifier } from "../realtime/outbox-order-notifier.js";
import { PostgresStoreSettingsReader } from "../db/store-settings-reader.js";
import { OrderPrinterAdapter } from "../../integrations/printer/order-printer-adapter.js";
import { CustomerNotifierAdapter } from "../../integrations/whatsapp/customer-notifier-adapter.js";
import { createOrderUsecases } from "../../application/order/order.usecases.js";
import { createAlertUsecases } from "../../application/alert/alert.usecases.js";
import { createStockUsecases } from "../../application/stock/stock.usecases.js";
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
const cacheFor = (schemaName: string) => new TenantCacheAdapter({ schemaName });

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

// getSettings — legado (o port StoreSettingsReader é o caminho novo)
export const getSettings = () => new PostgresStoreSettingsReader().get();

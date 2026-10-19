import type { Tx } from "./client.js";
import type { TenantSession } from "../../application/ports/unit-of-work.js";
import {
  PostgresAlertRepository,
  PostgresAuditRepository,
  PostgresAuditWriter,
  PostgresCatalogRepository,
  PostgresCashFlowRepository,
  PostgresCustomerRepository,
  PostgresCustomerAddressRepository,
  PostgresCustomerCartRepository,
  PostgresCourierLocationRepository,
  PostgresDeliveryRepository,
  PostgresGeocodingCacheRepository,
  PostgresIdentityRepository,
  PostgresOrderRepository,
  PostgresOutboxWriter,
  PostgresProvisioningKeyRepository,
  PostgresPurchaseRepository,
  PostgresRefundRepository,
  PostgresReportRepository,
  PostgresStockRepository,
  PostgresStoreSettingsRepository,
  PostgresSupplierRepository,
  PostgresUserDeviceRepository,
  PostgresUserRepository,
} from "./postgres-repositories.js";

/**
 * Monta um `TenantSession` (repositórios + audit + outbox) sobre a transação
 * corrente — a fábrica injetada em `PostgresTenantUnitOfWork` (ONDA 2).
 *
 * Uma instância por transação: os adapters guardam o `tx` e são stateless
 * além disso, então reutilizar a mesma sessão entre transações não é previsto
 * (e não é necessário: o UoW cria uma nova a cada `run`).
 *
 * Todas as escritas de domínio, o `audit.record` e o `outbox.enqueue` saem
 * daqui na MESMA transação (regra do repo: audit + outbox no mesmo commit).
 */
export function createPostgresTenantSession(tx: Tx): TenantSession {
  return {
    catalog: new PostgresCatalogRepository(tx),
    customers: new PostgresCustomerRepository(tx),
    users: new PostgresUserRepository(tx),
    orders: new PostgresOrderRepository(tx),
    stock: new PostgresStockRepository(tx),
    cashFlow: new PostgresCashFlowRepository(tx),
    purchases: new PostgresPurchaseRepository(tx),
    suppliers: new PostgresSupplierRepository(tx),
    refunds: new PostgresRefundRepository(tx),
    deliveries: new PostgresDeliveryRepository(tx),
    courierLocations: new PostgresCourierLocationRepository(tx),
    storeSettings: new PostgresStoreSettingsRepository(tx),
    geocodingCache: new PostgresGeocodingCacheRepository(tx),
    customerCarts: new PostgresCustomerCartRepository(tx),
    customerAddresses: new PostgresCustomerAddressRepository(tx),
    alerts: new PostgresAlertRepository(tx),
    auditLog: new PostgresAuditRepository(tx),
    reports: new PostgresReportRepository(tx),
    provisioningKeys: new PostgresProvisioningKeyRepository(tx),
    userDevices: new PostgresUserDeviceRepository(tx),
    // Identidade centralizada (docs/26 §3): tabelas GLOBAIS em `public.*`, na
    // MESMA transação da escrita de tenant (convite atômico).
    identity: new PostgresIdentityRepository(tx),
    audit: new PostgresAuditWriter(tx),
    outbox: new PostgresOutboxWriter(tx),
  };
}

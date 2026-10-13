import type { TenantContext } from "./tenant-context.js";
import type {
  AuditWriter,
  OutboxWriter,
  AlertRepository,
  AuditRepository,
  CatalogRepository,
  CustomerRepository,
  UserRepository,
  OrderRepository,
  StockRepository,
  CashFlowRepository,
  PurchaseRepository,
  SupplierRepository,
  RefundRepository,
  SettlementRepository,
  PaymentRepository,
  DeliveryRepository,
  CourierLocationRepository,
  StoreSettingsRepository,
  GeocodingCacheRepository,
  CustomerCartRepository,
  CustomerAddressRepository,
  ReportRepository,
  ProvisioningKeyRepository,
  UserDeviceRepository,
} from "./repositories.js";

export interface TenantSession {
  catalog: CatalogRepository;
  customers: CustomerRepository;
  users: UserRepository;
  orders: OrderRepository;
  stock: StockRepository;
  cashFlow: CashFlowRepository;
  purchases: PurchaseRepository;
  /** ADIÇÃO (Onda financeiro — compras): fornecedores (`supplier`). */
  suppliers: SupplierRepository;
  /** ADIÇÃO (Onda financeiro — estornos do balcão, Bloco 4): `order_refund`. */
  refunds: RefundRepository;
  /** ADIÇÃO (Onda financeiro — liquidações iFood, Bloco 5): `order_settlement`. */
  settlements: SettlementRepository;
  payments: PaymentRepository;
  deliveries: DeliveryRepository;
  /** ADIÇÃO (Onda 3 — self-service): última posição do entregador (`courier_location`). */
  courierLocations: CourierLocationRepository;
  /** ADIÇÃO (Onda 3): escrita do singleton `store_settings` (geocode do restaurante). */
  storeSettings: StoreSettingsRepository;
  /** ADIÇÃO (Onda 3): cache persistente de reverse geocoding (cálculo de entrega). */
  geocodingCache: GeocodingCacheRepository;
  /** ADIÇÃO (Onda 3 — self-service): carrinho server-side (`customer_cart`), chaveado pelo telefone. */
  customerCarts: CustomerCartRepository;
  /** ADIÇÃO (Onda 3 — self-service): endereços de cliente (`customer_address`). */
  customerAddresses: CustomerAddressRepository;
  /** ADIÇÃO (Onda 2): central de alertas (sino) — hub de pedidos. */
  alerts: AlertRepository;
  /** ADIÇÃO (Onda 3B): leitura da trilha de auditoria (`GET /audit-log`). */
  auditLog: AuditRepository;
  /** ADIÇÃO (Onda 3D): relatórios gerenciais (`/reports/sales|overview|deliveries`). */
  reports: ReportRepository;
  /** ADIÇÃO (device provisioning — docs/21): chaves de provisionamento (`provisioning_key`). */
  provisioningKeys: ProvisioningKeyRepository;
  /** ADIÇÃO (device provisioning — docs/21): aparelhos provisionados (`user_device`). */
  userDevices: UserDeviceRepository;
  audit: AuditWriter;
  outbox: OutboxWriter;
}

export interface TenantUnitOfWork {
  run<T>(tenant: TenantContext, work: (session: TenantSession) => Promise<T>): Promise<T>;
}

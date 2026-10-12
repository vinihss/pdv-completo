import type { TenantContext } from "./tenant-context.js";
import type { AuditWriter, OutboxWriter, CatalogRepository, CustomerRepository, UserRepository, OrderRepository, StockRepository, CashFlowRepository, PurchaseRepository, PaymentRepository, DeliveryRepository } from "./repositories.js";

export interface TenantSession {
  catalog: CatalogRepository;
  customers: CustomerRepository;
  users: UserRepository;
  orders: OrderRepository;
  stock: StockRepository;
  cashFlow: CashFlowRepository;
  purchases: PurchaseRepository;
  payments: PaymentRepository;
  deliveries: DeliveryRepository;
  audit: AuditWriter;
  outbox: OutboxWriter;
}

export interface TenantUnitOfWork {
  run<T>(tenant: TenantContext, work: (session: TenantSession) => Promise<T>): Promise<T>;
}

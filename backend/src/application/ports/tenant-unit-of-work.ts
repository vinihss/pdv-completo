import type { TenantContext } from "./tenant-context.js";
import type { AuditWriter } from "./audit.port.js";
import type { OutboxWriter } from "./outbox.port.js";
import type { CatalogRepository } from "./repositories/catalog.port.js";
import type { OrderRepository } from "./repositories/orders.port.js";
import type { CustomerRepository } from "./repositories/customers.port.js";
import type { UserRepository } from "./repositories/users.port.js";
import type { CashFlowRepository } from "./repositories/cash-flow.port.js";
import type { StockRepository } from "./repositories/stock.port.js";
import type { PurchaseRepository } from "./repositories/purchases.port.js";
import type { PaymentRepository } from "./repositories/payments.port.js";
import type { DeliveryRepository } from "./repositories/deliveries.port.js";

/** Ports vinculados à MESMA transação/conexão tenant-aware. */
export interface TenantSession {
  readonly catalog: CatalogRepository;
  readonly orders: OrderRepository;
  readonly customers: CustomerRepository;
  readonly users: UserRepository;
  readonly cashFlow: CashFlowRepository;
  readonly stock: StockRepository;
  readonly purchases: PurchaseRepository;
  readonly payments: PaymentRepository;
  readonly deliveries: DeliveryRepository;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

/**
 * Uma unidade de trabalho por caso de uso. A implementação deve abrir uma
 * transação, associar o TenantContext na mesma conexão e fazer commit/rollback.
 * Nunca expor Pool, Drizzle ou Tx nesta interface.
 */
export interface TenantUnitOfWork {
  run<T>(tenant: TenantContext, work: (session: TenantSession) => Promise<T>): Promise<T>;
}

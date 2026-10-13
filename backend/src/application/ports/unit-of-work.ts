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
  PaymentRepository,
  DeliveryRepository,
} from "./repositories.js";

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
  /** ADIÇÃO (Onda 2): central de alertas (sino) — hub de pedidos. */
  alerts: AlertRepository;
  /** ADIÇÃO (Onda 3B): leitura da trilha de auditoria (`GET /audit-log`). */
  auditLog: AuditRepository;
  audit: AuditWriter;
  outbox: OutboxWriter;
}

export interface TenantUnitOfWork {
  run<T>(tenant: TenantContext, work: (session: TenantSession) => Promise<T>): Promise<T>;
}

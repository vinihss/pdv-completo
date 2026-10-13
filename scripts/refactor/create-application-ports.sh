#!/usr/bin/env bash
set -Eeuo pipefail

# Scaffold inicial de contracts/ports. Não altera consumers existentes nem implementa
# queries Drizzle automaticamente; adapters e migração dos use cases são passos separados.
# Execute a partir de qualquer diretório: o script localiza a raiz do repositório.

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

DEST="$ROOT/backend/src/application/ports"

usage() {
  cat <<'EOF'
Uso: bash scripts/refactor/create-application-ports.sh

Gera os contratos TypeScript em backend/src/application/ports.
Por segurança, o script aborta antes de escrever se algum destino já existir.
Ele não altera use cases, rotas, migrations nem adapters.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "Erro: argumento não reconhecido: $1" >&2
  usage >&2
  exit 2
fi

# Pré-validação completa: evita sobrescrever código ou deixar scaffold parcial por
# colisão previsível de nomes.
files=(
  "tenant-context.ts"
  "tenant-unit-of-work.ts"
  "persistence.ts"
  "audit.port.ts"
  "outbox.port.ts"
  "cache.port.ts"
  "file-storage.port.ts"
  "idempotency.port.ts"
  "auth.port.ts"
  "payment-gateway.port.ts"
  "delivery-services.port.ts"
  "notifications.port.ts"
  "repositories/catalog.port.ts"
  "repositories/orders.port.ts"
  "repositories/customers.port.ts"
  "repositories/users.port.ts"
  "repositories/cash-flow.port.ts"
  "repositories/stock.port.ts"
  "repositories/purchases.port.ts"
  "repositories/payments.port.ts"
  "repositories/deliveries.port.ts"
  "repositories/reports.port.ts"
  "repositories/tenant-registry.port.ts"
)

collisions=()
for rel in "${files[@]}"; do
  [[ -e "$DEST/$rel" ]] && collisions+=("$DEST/$rel")
done
if ((${#collisions[@]})); then
  printf 'Erro: estes destinos já existem; nada foi escrito:\n' >&2
  printf '  %s\n' "${collisions[@]}" >&2
  echo 'Revise os arquivos e adapte o script manualmente; ele não sobrescreve nem oferece force.' >&2
  exit 1
fi

mkdir -p "$DEST/repositories"
created=()
cleanup() {
  local status=$?
  if ((status != 0)); then
    for rel in "${created[@]}"; do rm -f "$DEST/$rel"; done
    echo 'Falha durante a geração; arquivos criados por esta execução foram removidos.' >&2
  fi
  exit "$status"
}
trap cleanup EXIT

write_file() {
  local rel="$1"
  cat > "$DEST/$rel"
  created+=("$rel")
}

write_file tenant-context.ts <<'EOF'
/** Contexto autenticado e resolvido por uma borda confiável (HTTP/job/webhook). */
export interface TenantContext {
  /** Identificador interno imutável; não usar slug como chave de isolamento se ele puder mudar. */
  tenantId: string;
  /** Identificador legível usado para host/URL; não é fonte de autorização por si só. */
  slug: string;
  source: "http" | "worker" | "webhook" | "internal";
}

/** Escopo exclusivamente de operações globais/control-plane, sem fallback implícito. */
export interface PlatformContext {
  actor: "system" | "operator";
  reason: string;
}
EOF

write_file persistence.ts <<'EOF'
/** Identificadores e tipos neutros de persistência; não exportar tipos Drizzle/pg daqui. */
export type EntityId = string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PageRequest {
  limit: number;
  /** Cursor opaco, definido pelo adapter. */
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Erros independentes do driver, mapeados pelos adapters de persistência. */
export type PersistenceErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONSTRAINT"
  | "UNAVAILABLE"
  | "UNKNOWN";

export class PersistenceError extends Error {
  constructor(
    public readonly code: PersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PersistenceError";
  }
}
EOF

write_file tenant-unit-of-work.ts <<'EOF'
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
EOF

write_file audit.port.ts <<'EOF'
import type { EntityId, JsonValue } from "./persistence.js";

export interface AuditEntry {
  actorId: EntityId | null;
  action: string;
  entityType: string;
  entityId: EntityId | null;
  details?: JsonValue;
}

/** Escrita deve compartilhar a transação da TenantSession quando chamada nela. */
export interface AuditWriter {
  record(entry: AuditEntry): Promise<void>;
}

export interface AuditLogReader {
  list(query: { limit: number; cursor?: string; actorId?: EntityId }): Promise<{
    items: Array<AuditEntry & { id: EntityId; createdAt: string }>;
    nextCursor: string | null;
  }>;
}
EOF

write_file outbox.port.ts <<'EOF'
import type { EntityId, JsonValue } from "./persistence.js";

export interface OutboxMessage {
  type: string;
  aggregateId: EntityId;
  payload?: JsonValue;
  /** Chave opcional para deduplicação do consumidor. */
  deduplicationKey?: string;
}

/** Enfileira intenção durável dentro da mesma transação da mudança de negócio. */
export interface OutboxWriter {
  enqueue(message: OutboxMessage): Promise<void>;
}

/** Dispatcher/worker é adapter de runtime, não parte da aplicação. */
export interface OutboxDispatcher {
  start(): { stop(): Promise<void> | void };
}
EOF

write_file cache.port.ts <<'EOF'
import type { TenantContext } from "./tenant-context.js";

export interface CachePort {
  get<T>(tenant: TenantContext, key: string): Promise<T | null>;
  set<T>(tenant: TenantContext, key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(tenant: TenantContext, key: string): Promise<void>;
  invalidatePrefix(tenant: TenantContext, prefix: string): Promise<void>;
}
EOF

write_file file-storage.port.ts <<'EOF'
import type { Buffer } from "node:buffer";
import type { TenantContext } from "./tenant-context.js";

export type FileKind = "product" | "logo" | "customer" | "user";

export interface StoredFile {
  body: Buffer;
  contentType: string;
  size: number;
  etag: string | null;
  lastModified: Date | null;
}

/** Tenant explícito; o contrato não revela filesystem, bucket nem schema PostgreSQL. */
export interface FileStoragePort {
  put(tenant: TenantContext, kind: FileKind, filename: string, body: Buffer): Promise<void>;
  get(tenant: TenantContext, kind: FileKind, filename: string): Promise<StoredFile | null>;
  remove(tenant: TenantContext, kind: FileKind, filename: string): Promise<boolean>;
}
EOF

write_file idempotency.port.ts <<'EOF'
import type { EntityId } from "./persistence.js";
import type { TenantContext } from "./tenant-context.js";

export interface IdempotencyRequest {
  tenant: TenantContext;
  key: string;
  requestHash: string;
  operation: string;
}

export type IdempotencyResult<T> =
  | { status: "acquired"; correlationId: EntityId }
  | { status: "completed"; response: T; httpStatus: number }
  | { status: "processing" }
  | { status: "conflict" };

export interface IdempotencyPort {
  acquire<T>(request: IdempotencyRequest): Promise<IdempotencyResult<T>>;
  complete<T>(input: { tenant: TenantContext; correlationId: EntityId; response: T; httpStatus: number }): Promise<void>;
  fail(input: { tenant: TenantContext; correlationId: EntityId }): Promise<void>;
}
EOF

write_file auth.port.ts <<'EOF'
import type { EntityId } from "./persistence.js";
import type { TenantContext } from "./tenant-context.js";

export interface AuthenticatedUser {
  id: EntityId;
  tenantId: string;
  role: string;
  active: boolean;
}

export interface UserStatusReader {
  findActiveUser(tenant: TenantContext, userId: EntityId): Promise<AuthenticatedUser | null>;
}

export interface PinVerifier {
  verify(pin: string, encodedHash: string): Promise<boolean>;
}

export interface AccessTokenIssuer {
  issue(user: AuthenticatedUser): Promise<string>;
}
EOF

write_file payment-gateway.port.ts <<'EOF'
import type { EntityId, JsonValue } from "./persistence.js";

export interface ChargeRequest {
  paymentId: EntityId;
  amountMinor: number;
  currency: string;
  method: string;
  idempotencyKey: string;
  metadata?: JsonValue;
}

export interface ChargeResult {
  provider: string;
  providerChargeId: string;
  status: string;
  raw?: JsonValue;
}

export interface RefundRequest {
  paymentId: EntityId;
  providerChargeId: string;
  amountMinor: number;
  idempotencyKey: string;
}

/** Contrato consumido por application; credenciais/HTTP/SDK ficam no adapter. */
export interface PaymentGateway {
  createCharge(input: ChargeRequest): Promise<ChargeResult>;
  refund(input: RefundRequest): Promise<{ providerRefundId: string; status: string }>;
}
EOF

write_file delivery-services.port.ts <<'EOF'
export interface Coordinates { latitude: number; longitude: number }
export interface RouteResult { distanceMeters: number; durationSeconds: number }

export interface GeocodingService {
  geocode(address: string): Promise<Coordinates | null>;
}
export interface RoutingService {
  route(origin: Coordinates, destination: Coordinates): Promise<RouteResult | null>;
}
EOF

write_file notifications.port.ts <<'EOF'
import type { EntityId, JsonValue } from "./persistence.js";

export interface NotificationMessage {
  recipient: string;
  template: string;
  data: JsonValue;
  correlationId?: EntityId;
}
export interface OrderNotifier {
  send(message: NotificationMessage): Promise<void>;
}
export interface PrinterPort {
  printOrder(input: { orderId: EntityId; copy?: "customer" | "kitchen" }): Promise<void>;
}
export interface MailerPort {
  send(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}
EOF

write_file repositories/catalog.port.ts <<'EOF'
import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface ProductSummary { id: EntityId; name: string; active: boolean }
export interface CategorySummary { id: EntityId; name: string; active: boolean }
export interface CatalogRepository {
  listProducts(page: PageRequest, filters?: { active?: boolean; search?: string }): Promise<Page<ProductSummary>>;
  findProduct(id: EntityId): Promise<ProductSummary | null>;
  saveProduct(input: Omit<ProductSummary, "id"> & { id?: EntityId }): Promise<ProductSummary>;
  listCategories(): Promise<CategorySummary[]>;
  saveCategory(input: Omit<CategorySummary, "id"> & { id?: EntityId }): Promise<CategorySummary>;
}
EOF

write_file repositories/orders.port.ts <<'EOF'
import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface OrderSummary { id: EntityId; status: string; totalMinor: number; tableId: EntityId | null }
export interface OrderRepository {
  findById(id: EntityId): Promise<OrderSummary | null>;
  findOpenForTable(tableId: EntityId): Promise<OrderSummary | null>;
  listOpen(page: PageRequest): Promise<Page<OrderSummary>>;
  create(input: { tableId?: EntityId | null; customerId?: EntityId | null; channel: string }): Promise<OrderSummary>;
  updateStatus(id: EntityId, status: string): Promise<OrderSummary>;
  delete(id: EntityId): Promise<void>;
}
EOF

write_file repositories/customers.port.ts <<'EOF'
import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface CustomerSummary { id: EntityId; name: string; phone: string | null }
export interface CustomerRepository {
  findById(id: EntityId): Promise<CustomerSummary | null>;
  findByPhone(phone: string): Promise<CustomerSummary | null>;
  list(page: PageRequest, search?: string): Promise<Page<CustomerSummary>>;
  save(input: Omit<CustomerSummary, "id"> & { id?: EntityId }): Promise<CustomerSummary>;
  delete(id: EntityId): Promise<void>;
}
EOF

write_file repositories/users.port.ts <<'EOF'
import type { EntityId } from "../persistence.js";
export interface UserRecord { id: EntityId; name: string; role: string; active: boolean; pinHash: string }
export interface UserRepository {
  findById(id: EntityId): Promise<UserRecord | null>;
  findByLogin(login: string): Promise<UserRecord | null>;
  listActive(): Promise<Array<Pick<UserRecord, "id" | "name" | "role">>>;
  save(input: Omit<UserRecord, "id"> & { id?: EntityId }): Promise<UserRecord>;
  setActive(id: EntityId, active: boolean): Promise<void>;
}
EOF

write_file repositories/cash-flow.port.ts <<'EOF'
import type { EntityId } from "../persistence.js";
export interface CashDrawer { id: EntityId; status: "open" | "closed"; openedAt: string }
export interface CashFlowRepository {
  findOpenDrawerForUpdate(): Promise<CashDrawer | null>;
  openDrawer(input: { openedBy: EntityId; openingAmountMinor: number }): Promise<CashDrawer>;
  recordMovement(input: { drawerId: EntityId; actorId: EntityId; type: string; amountMinor: number; note?: string }): Promise<void>;
  closeDrawer(input: { drawerId: EntityId; closedBy: EntityId; countedAmountMinor: number }): Promise<void>;
}
EOF

write_file repositories/stock.port.ts <<'EOF'
import type { EntityId } from "../persistence.js";
export interface StockBalance { productId: EntityId; quantity: number }
export interface StockRepository {
  getBalance(productId: EntityId): Promise<StockBalance>;
  recordMovement(input: { productId: EntityId; quantityDelta: number; reason: string; referenceId?: EntityId }): Promise<void>;
  reserveForOrder(orderId: EntityId): Promise<void>;
  releaseForOrder(orderId: EntityId): Promise<void>;
}
EOF

write_file repositories/purchases.port.ts <<'EOF'
import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface PurchaseSummary { id: EntityId; supplierId: EntityId | null; totalMinor: number; status: string }
export interface PurchaseRepository {
  findById(id: EntityId): Promise<PurchaseSummary | null>;
  list(page: PageRequest): Promise<Page<PurchaseSummary>>;
  create(input: { supplierId?: EntityId | null; actorId: EntityId }): Promise<PurchaseSummary>;
  addItem(input: { purchaseId: EntityId; productId: EntityId; quantity: number; unitCostMinor: number }): Promise<void>;
  finalize(id: EntityId): Promise<PurchaseSummary>;
}
EOF

write_file repositories/payments.port.ts <<'EOF'
import type { EntityId, JsonValue } from "../persistence.js";
export interface PaymentRecord { id: EntityId; orderId: EntityId; amountMinor: number; status: string; provider: string | null }
export interface PaymentRepository {
  findById(id: EntityId): Promise<PaymentRecord | null>;
  findByOrder(orderId: EntityId): Promise<PaymentRecord[]>;
  create(input: Omit<PaymentRecord, "id">): Promise<PaymentRecord>;
  transition(id: EntityId, status: string, providerData?: JsonValue): Promise<PaymentRecord>;
  recordProviderEvent(input: { provider: string; eventId: string; eventType: string; payload: JsonValue }): Promise<"recorded" | "duplicate">;
}
EOF

write_file repositories/deliveries.port.ts <<'EOF'
import type { EntityId, Page, PageRequest } from "../persistence.js";
export interface DeliverySummary { id: EntityId; orderId: EntityId; status: string; courierId: EntityId | null }
export interface DeliveryRepository {
  findById(id: EntityId): Promise<DeliverySummary | null>;
  findByOrder(orderId: EntityId): Promise<DeliverySummary | null>;
  list(page: PageRequest, filters?: { status?: string; courierId?: EntityId }): Promise<Page<DeliverySummary>>;
  assignCourier(id: EntityId, courierId: EntityId): Promise<DeliverySummary>;
  transition(id: EntityId, status: string): Promise<DeliverySummary>;
}
EOF

write_file repositories/reports.port.ts <<'EOF'
export interface DateRange { from: string; to: string }
export interface SalesReport { totalMinor: number; orderCount: number; byDay: Array<{ day: string; totalMinor: number; count: number }> }
export interface DeliveryReport { deliveryCount: number; averageDurationSeconds: number | null }
/** Read models específicos; SQL/joins/índices ficam no adapter PostgreSQL. */
export interface ReportsReader {
  sales(range: DateRange): Promise<SalesReport>;
  deliveries(range: DateRange): Promise<DeliveryReport>;
  overview(at: string): Promise<Record<string, number | null>>;
}
EOF

write_file repositories/tenant-registry.port.ts <<'EOF'
/** Control-plane global: não é um repository tenant-scoped e não usa fallback de tenant. */
export interface TenantRecord { tenantId: string; slug: string; active: boolean }
export interface TenantRegistryPort {
  findBySlug(slug: string): Promise<TenantRecord | null>;
  findById(tenantId: string): Promise<TenantRecord | null>;
  listActive(): Promise<TenantRecord[]>;
}
EOF

trap - EXIT
printf 'Criados %d arquivos em %s\n' "${#files[@]}" "$DEST"
printf '%s\n' 'Próximos passos: revisar contratos, implementar adapters e migrar use cases por feature.'

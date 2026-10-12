/**
 * Ports de repositório (persistência) e de efeitos transacionais — FASE 0 da
 * refatoração arquitetural. Contrato CONGELADO: os use cases migrados falam
 * com estas interfaces; os adapters Postgres (`src/infra/db/postgres-*`)
 * traduzem para Drizzle/schema.
 *
 * ---------------------------------------------------------------------------
 * NOTA SOBRE `AuditWriter` E `OutboxWriter` (adaptação ao modelo real):
 * a spec original previa `AuditWriter.record({ actorId, action, entityType,
 * entityId, details })` e `OutboxWriter.enqueue({ type, aggregateId, payload })`,
 * mas o código real do repositório usa `logAction(tx, userId, action, orderId,
 * details)` e `enqueueEvent(tx, room, eventType, payload)`. Para não perder
 * informação na tradução, os ports acrescentam:
 *   - `AuditWriter.record`: `orderId?: Id | null` (coluna real `audit_log.order_id`;
 *     sem ela, o audit de eventos de comanda ficaria órfão);
 *   - `OutboxWriter.enqueue`: `room: string` OBRIGATÓRIO (coluna real
 *     `outbox_event.room`; o "type" do spec vira `eventType`).
 * Os adapters transacionais traduzem 1:1 para as funções acima.
 * ---------------------------------------------------------------------------
 *
 * Estas assinaturas vêm do spec; onde o spec divergiu do código real a nota
 * está no campo/comentário. Campos de apresentação (URL de foto, nomes de
 * categoria resolvidos, etc.) NÃO entram no record: quem serializa é o use case.
 */

// ---------- tipos primitivos ----------

export type Id = string;

/** JSON genérico (payloads de audit/outbox/metadata). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface PageQuery {
  limit: number;
  offset: number;
}

export interface Page<T> {
  data: T[];
  total: number;
}

// ---------- unions de status (espelham os enums do schema, sem importá-lo) ----------

export type OrderStatus = "open" | "closed" | "cancelled";
export type DeliveryStatus =
  | "awaiting_courier"
  | "out_for_delivery"
  | "delivered"
  | "failed"
  | "cancelled";
export type StockMovementKind = "sale" | "refund" | "purchase" | "adjustment";
export type PaymentMethodKind = "cash" | "card" | "pix" | "other";
export type UserRole = "waiter" | "kitchen" | "manager" | "courier" | "system" | "cashier";
export type CashMovementKind = "sangria" | "suprimento";

// ---------- records ----------

export interface ProductRecord {
  id: Id;
  categoryId: Id | null;
  kitchenGroupId: Id | null;
  name: string;
  description: string;
  price: number;
  active: boolean;
  imagePath: string | null;
}

export interface CustomerRecord {
  id: Id;
  name: string;
  phone: string | null;
  email: string | null;
  /** CPF crudo (11 dígitos, sem máscara) — normalização é do use case. */
  cpf: string | null;
  notes: string | null;
  /** Só o basename (`<id>.<ext>`); o caminho público é do serializador. */
  photoPath: string | null;
  /** Soft-delete: manutenção desativa, não apaga (histórico de pedidos). */
  active: boolean;
  createdAt: string;
}

export interface UserRecord {
  id: Id;
  name: string;
  role: UserRole;
  /** Hash argon2 do PIN. O port NÃO gera PIN: o use case hasheia e passa aqui. */
  pinHash: string;
  active: boolean;
  phone: string | null;
  email: string | null;
  photoPath: string | null;
  createdAt: string;
}

export interface OrderRecord {
  id: Id;
  status: OrderStatus;
  /** Soma dos itens (snapshot `unit_price`, excluindo `cancelled`) + taxa de entrega — computado pelo adapter, igual a `computeOrderTotal`. */
  total: number;
  tableId: Id | null;
}

export interface PaymentRecord {
  id: Id;
  orderId: Id;
  /** Tentativa 1, 2, 3... (índice `uq_payment_order_attempt`). */
  attempt: number;
  provider: string;
  providerOrderId: string | null;
  providerChargeId: string | null;
  providerPaymentId: string | null;
  method: string;
  amount: number;
  currency: string;
  status: string;
  refundedAmount: number;
  failureReason: string | null;
  qrCode: string | null;
  qrCodeBase64: string | null;
  qrCodeUrl: string | null;
  pixTxid: string | null;
  pixExpiresAt: string | null;
  paidAt: string | null;
  canceledAt: string | null;
  /** JSON serializado (coluna `text`), mesmo formato do banco. */
  metadata: Json;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRecord {
  id: Id;
  orderId: Id;
  courierId: Id | null;
  address: string;
  distanceKm: number | null;
  estimatedMinutes: number | null;
  status: DeliveryStatus;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  notes: string | null;
  arrivalAlertSent: boolean;
  createdAt: string;
}

export interface PurchaseRecord {
  id: Id;
  supplierId: Id | null;
  invoiceNumber: string | null;
  issuedOn: string | null;
  note: string | null;
  total: number;
  createdBy: Id;
  createdAt: string;
}

// ---------- repositórios ----------

export interface CatalogRepository {
  listProducts(
    query: PageQuery & { categoryId?: Id; active?: boolean; search?: string; sort?: string },
  ): Promise<Page<ProductRecord>>;
  findProduct(id: Id): Promise<ProductRecord | null>;
  /** `input.id` presente = update; ausente = create. Defaults de criação = mesmos de `createProductUsecase`. */
  saveProduct(input: Partial<ProductRecord> & Pick<ProductRecord, "name" | "price">): Promise<ProductRecord>;
  listCategories(): Promise<Array<{ id: Id; name: string; active: boolean }>>;
  listKitchenGroups(): Promise<Array<{ id: Id; name: string }>>;
}

export interface CustomerRepository {
  findById(id: Id): Promise<CustomerRecord | null>;
  findByPhone(phone: string): Promise<CustomerRecord | null>;
  list(query: PageQuery & { search?: string }): Promise<Page<CustomerRecord>>;
  /** `input.id` presente = update; ausente = create. Normalização (phone/email/cpf) fica no use case. */
  save(input: Partial<CustomerRecord> & Pick<CustomerRecord, "name">): Promise<CustomerRecord>;
  /** Soft-delete (seta `active=false`) — cliente tem histórico, nunca é apagado. */
  delete(id: Id): Promise<void>;
}

export interface UserRepository {
  findById(id: Id): Promise<UserRecord | null>;
  /** Login por id, telefone ou email (case-insensitive) — o use case de login valida PIN/lock depois. */
  findByLogin(login: string): Promise<UserRecord | null>;
  listActive(): Promise<Array<Pick<UserRecord, "id" | "name" | "role">>>;
  /** `input.id` presente = update; ausente = create (exige `pinHash` já argon2-hasheado pelo use case). */
  save(input: Partial<UserRecord> & Pick<UserRecord, "name" | "role">): Promise<UserRecord>;
}

export interface OrderRepository {
  findById(id: Id): Promise<OrderRecord | null>;
  findOpenForTable(tableId: Id): Promise<OrderRecord | null>;
  listOpen(query: PageQuery): Promise<Page<OrderRecord>>;
  create(input: { tableId?: Id | null; customerId?: Id | null; channel: string }): Promise<OrderRecord>;
  transition(id: Id, status: OrderStatus, expectedVersion?: number): Promise<OrderRecord>;
  delete(id: Id): Promise<void>;
}

export interface StockRepository {
  /** Saldo do ledger = soma de `quantity_delta` (nunca coluna cacheada). */
  balance(productId: Id): Promise<number>;
  /**
   * Grava um movimento no ledger. Devolve o saldo PÓS-movimento (mesmo papel
   * do retorno de `applyStockMovementTx`).
   */
  recordMovement(input: {
    productId: Id;
    quantityDelta: number;
    type: StockMovementKind;
    unitCost?: number;
    orderItemId?: Id;
    note?: string;
    actorId?: Id;
  }): Promise<number>;
  reserveForOrder(orderId: Id): Promise<void>;
  releaseForOrder(orderId: Id): Promise<void>;
}

export interface CashFlowRepository {
  findOpenForUpdate(): Promise<{ id: Id; openedAt: string } | null>;
  open(input: { actorId: Id; openingAmount: number }): Promise<{ id: Id; openedAt: string }>;
  recordMovement(input: { drawerId: Id; actorId: Id; type: CashMovementKind; amount: number; note?: string }): Promise<void>;
  close(input: { drawerId: Id; actorId: Id; countedAmount: number }): Promise<void>;
}

export interface PurchaseRepository {
  findById(id: Id): Promise<PurchaseRecord | null>;
  create(input: { supplierId?: Id | null; actorId: Id }): Promise<PurchaseRecord>;
  addItem(input: { purchaseId: Id; productId: Id; quantity: number; unitCost: number }): Promise<void>;
  finalize(id: Id): Promise<void>;
}

export interface PaymentRepository {
  findById(id: Id): Promise<PaymentRecord | null>;
  findByOrder(orderId: Id): Promise<PaymentRecord[]>;
  create(input: Omit<PaymentRecord, "id">): Promise<PaymentRecord>;
  transition(id: Id, status: string, providerData?: Json): Promise<PaymentRecord>;
}

export interface DeliveryRepository {
  findById(id: Id): Promise<DeliveryRecord | null>;
  findByOrder(orderId: Id): Promise<DeliveryRecord | null>;
  list(query: PageQuery & { status?: DeliveryStatus; courierId?: Id }): Promise<Page<DeliveryRecord>>;
  /** Atribui o entregador (não muda o status — segue awaiting_courier até o dispatch). */
  assignCourier(id: Id, courierId: Id): Promise<DeliveryRecord>;
  transition(id: Id, status: DeliveryStatus): Promise<DeliveryRecord>;
}

// ---------- efeitos transacionais (mesma transação da escrita de domínio) ----------

export interface AuditWriter {
  record(input: {
    actorId: Id | null;
    action: string;
    entityType?: string;
    entityId?: Id | null;
    /** ADIÇÃO ao spec: coluna real `audit_log.order_id` (ver nota no topo). */
    orderId?: Id | null;
    details?: Json;
  }): Promise<void>;
}

export interface OutboxWriter {
  enqueue(input: {
    /** ADIÇÃO ao spec: coluna real `outbox_event.room` — sem ela o evento não sabe para onde ir (ver nota no topo). */
    room: string;
    /** O "type" do spec vira `eventType` no banco. */
    type: string;
    aggregateId: Id;
    payload?: Json;
  }): Promise<void>;
}

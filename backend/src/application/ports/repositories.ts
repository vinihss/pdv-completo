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
 *
 * ---------------------------------------------------------------------------
 * ADIÇÕES (Onda 2 — migração do hub de pedidos): `order.usecases`,
 * `stock.usecases`, `alert.usecases` e `customer-stage` passaram a falar com
 * estes ports; os records/métodos novos estão marcados "ADIÇÃO (Onda 2)".
 * Nenhum contrato existente foi removido — os métodos legados continuam
 * intactos (os não implementados seguem lançando `not_implemented`).
 * ---------------------------------------------------------------------------
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

/**
 * ADIÇÃO (Onda 2): mesa do salão (`restaurant_table`), usada pelo hub de
 * pedidos (claim atômico na abertura, "Mesa 3" no alerta, GET /tables).
 */
export interface TableRecord {
  id: Id;
  number: string;
  status: "free" | "occupied" | "closing";
  createdAt: string;
}

/**
 * ADIÇÃO (Onda 2): produto do ponto de vista do LANÇAMENTO de item — o
 * `ProductRecord` do catálogo não traz snapshot de custo, rastreamento de
 * estoque nem threshold, que `addItemsUsecase`/`registerStockMovementUsecase`
 * precisam. Campo a campo, é o que `addItems` lê de `products`.
 */
export interface OrderingProductRecord {
  id: Id;
  name: string;
  price: number;
  costPrice: number;
  active: boolean;
  imagePath: string | null;
  kitchenGroupId: Id | null;
  trackStock: boolean;
  lowStockThreshold: number;
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

// ---------- ADIÇÕES (Onda 2 — hub de pedidos): records de linha ----------

export type OrderChannel = "balcao" | "whatsapp" | "web" | "ifood";
export type OrderItemStatus = "ordered" | "ready" | "delivered" | "cancelled";

/** Linha completa de `order` (todas as colunas), fiel ao schema. */
export interface OrderRow {
  id: Id;
  tableId: Id | null;
  customerId: Id | null;
  tabLabel: string | null;
  waiterId: Id;
  status: OrderStatus;
  openedAt: string;
  closedAt: string | null;
  paymentMethod: string | null;
  paymentConfirmedAt: string | null;
  paymentConfirmedBy: Id | null;
  channel: OrderChannel;
  externalRef: string | null;
  deliveryFee: number | null;
  cancelReason: string | null;
  notes: string | null;
  ifoodPayments: string | null;
}

/** Linha completa de `order_item` (`selectedVariations` = string JSON, como no banco). */
export interface OrderItemRow {
  id: Id;
  orderId: Id;
  productId: Id;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  selectedVariations: string;
  notes: string | null;
  status: OrderItemStatus;
  version: number;
  createdBy: Id;
  createdAt: string;
  updatedAt: string;
}

/** Item + referências do produto (nome/foto/grupo de produção) — o que a tela da cozinha consome. */
export interface OrderItemWithProduct extends OrderItemRow {
  productName: string;
  productImagePath: string | null;
  productKitchenGroupId: Id | null;
}

/** Linha de `order_payment` (pagamento fracionado — 1 linha por forma). */
export interface OrderPaymentLineRow {
  id: Id;
  orderId: Id;
  method: PaymentMethodKind;
  amount: number;
  /** Só cash: quanto o cliente entregou. */
  received: number | null;
  /** Só cash: received - amount (troco). */
  change: number | null;
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: Id | null;
  createdBy: Id;
  createdAt: string;
}

/** Linha de `alert` (sino). */
export interface AlertRecord {
  id: Id;
  kind: string;
  title: string;
  body: string | null;
  orderId: Id | null;
  channel: string | null;
  /** Tokens de audiência: papel (`manager`) e/ou `user:<id>`. NULL/vazio = público. */
  audienceRoles: string[] | null;
  readAt: string | null;
  createdAt: string;
}

/** Linha de `stock_movement` (ledger). */
export interface StockMovementRecord {
  id: Id;
  productId: Id;
  type: StockMovementKind;
  quantityDelta: number;
  unitCost: number | null;
  purchaseItemId: Id | null;
  orderId: Id | null;
  orderItemId: Id | null;
  note: string | null;
  createdBy: Id;
  createdAt: string;
}

/** Custo médio móvel vigente — replay do ledger (mesmíssimo shape de `MovingAverage`). */
export interface MovingAverageRecord {
  avg: number;
  qty: number;
}

/** Produto rastreado na tela de Estoque (linha de `GET /stock`). */
export interface TrackedStockProductRecord {
  productId: Id;
  name: string;
  categoryId: Id | null;
  categoryName: string | null;
  unit: string;
  /** Custo manual do cadastro (a média móvel vigente é calculada pelo use case). */
  costPrice: number;
  lowStockThreshold: number;
}

/** Movimento do ledger com produto/usuário resolvidos (linha de `GET /stock/movements`). */
export interface StockMovementViewRecord {
  id: Id;
  productId: Id;
  productName: string | null;
  type: StockMovementKind;
  quantityDelta: number;
  unitCost: number | null;
  orderId: Id | null;
  note: string | null;
  userName: string | null;
  createdAt: string;
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

  // ---------- ADIÇÕES (Onda 2 — hub de pedidos) ----------
  /** Mesa (restaurant_table) por id — abertura de comanda e alerta "Mesa N". */
  findTable(id: Id): Promise<TableRecord | null>;
  /** Mesas em ordem de número (GET /tables). */
  listTables(): Promise<TableRecord[]>;
  /** Lote de mesas por ids (hidratação da listagem de comandas). */
  listTablesByIds(ids: Id[]): Promise<TableRecord[]>;
  /**
   * Claim atômico da mesa para abrir comanda: UPDATE condicional
   * `status = 'free'` → `occupied`. Devolve `false` quando nenhuma linha foi
   * alterada (mesa inexistente OU já ocupada) — a distinção 404/409 é do use
   * case (`findTable` em seguida), para não reintroduzir a corrida.
   */
  tryClaimTable(tableId: Id): Promise<boolean>;
  /** Libera a mesa (fechamento/cancelamento da comanda): volta para `free`. */
  releaseTable(tableId: Id): Promise<void>;
  /**
   * Produto com os campos que o LANÇAMENTO de item e o movimento manual de
   * estoque precisam (snapshot de preço/custo + rastreamento + estação).
   * `findProduct` não traz `trackStock`/`costPrice`/`lowStockThreshold`.
   */
  findProductForOrdering(id: Id): Promise<OrderingProductRecord | null>;
}

export interface CustomerRepository {
  findById(id: Id): Promise<CustomerRecord | null>;
  findByPhone(phone: string): Promise<CustomerRecord | null>;
  list(query: PageQuery & { search?: string }): Promise<Page<CustomerRecord>>;
  /** `input.id` presente = update; ausente = create. Normalização (phone/email/cpf) fica no use case. */
  save(input: Partial<CustomerRecord> & Pick<CustomerRecord, "name">): Promise<CustomerRecord>;
  /** Soft-delete (seta `active=false`) — cliente tem histórico, nunca é apagado. */
  delete(id: Id): Promise<void>;
  /** ADIÇÃO (Onda 2): lote por ids (hidratação da listagem de comandas — sem N+1). */
  findByIds(ids: Id[]): Promise<CustomerRecord[]>;
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

  // ---------- ADIÇÕES (Onda 2 — hub de pedidos) ----------
  /** Linha completa de `order` (todas as colunas) — o `OrderRecord` acima traz só o resumo. */
  findRow(id: Id): Promise<OrderRow | null>;
  /** Listagem de comandas (`GET /orders`): mais recentes primeiro + total (count). */
  listRows(query: { status?: OrderStatus; limit: number; offset: number }): Promise<Page<OrderRow>>;
  /**
   * INSERT da comanda (`POST /orders`): todos os campos do input do use case.
   * Identificação (mesa/cliente/tabLabel) e claim da mesa são do use case —
   * aqui vale o CHECK `chk_order_identification_required`.
   */
  open(input: {
    waiterId: Id;
    tableId?: Id | null;
    customerId?: Id | null;
    tabLabel?: string | null;
    channel?: OrderChannel;
    deliveryFee?: number | null;
    externalRef?: string | null;
    notes?: string | null;
  }): Promise<OrderRow>;
  /** Fechamento (`PATCH /orders/:id/close`): status + closedAt. Invariantas de pagamento ficam no use case. */
  markClosed(id: Id): Promise<OrderRow>;
  /** Cancelamento (`PATCH /orders/:id/cancel`): status + closedAt + cancelReason. */
  markCancelled(id: Id, reason: string): Promise<OrderRow>;
  /** Status das comandas em lote (alertas mostram "encerrada" sem N+1). */
  listStatuses(ids: Id[]): Promise<Array<{ id: Id; status: string }>>;

  // -- itens --
  /** Itens da comanda (linhas cruas — sem join de produto). */
  listItemRows(orderId: Id): Promise<OrderItemRow[]>;
  /** Itens + refs do produto (nome/foto/grupo) — o que `serializeItem` consome. */
  listItemsWithProduct(orderId: Id): Promise<OrderItemWithProduct[]>;
  /** Itens + refs em lote por comandas (listagem — uma query só). */
  listItemsWithProductForOrders(ids: Id[]): Promise<OrderItemWithProduct[]>;
  findItem(itemId: Id): Promise<OrderItemRow | null>;
  insertItem(input: {
    orderId: Id;
    productId: Id;
    quantity: number;
    unitPrice: number;
    costPrice: number;
    /** String JSON pronta (snapshot das variações escolhidas). */
    selectedVariations: string;
    notes?: string | null;
    createdBy: Id;
    status: OrderItemStatus;
  }): Promise<OrderItemRow>;
  /**
   * Mutação de item com LOCK OTIMISTA (coluna `version`). Devolve `null` quando
   * a versão não casa mais — o use case relê a linha e responde
   * `concurrency_conflict` com a versão corrente.
   */
  transitionItemStatus(itemId: Id, status: "ready" | "delivered", expectedVersion: number): Promise<OrderItemRow | null>;
  deleteItem(itemId: Id): Promise<void>;
  /** Cancela os itens pendentes da comanda (não `delivered`, não já `cancelled`). */
  cancelActiveItems(orderId: Id): Promise<void>;

  // -- linhas de pagamento (`order_payment` — pagamento fracionado) --
  listPaymentLines(orderId: Id): Promise<OrderPaymentLineRow[]>;
  /** Lote por comandas (listagem — uma query só). */
  listPaymentLinesForOrders(ids: Id[]): Promise<OrderPaymentLineRow[]>;
  findPaymentLine(id: Id): Promise<OrderPaymentLineRow | null>;
  insertPaymentLine(input: {
    orderId: Id;
    method: PaymentMethodKind;
    amount: number;
    received: number | null;
    change: number | null;
    confirmed: boolean;
    confirmedAt: string | null;
    confirmedBy: Id | null;
    createdBy: Id;
  }): Promise<OrderPaymentLineRow>;
  /** Atualiza `received`/`change` de uma linha preservada no PUT (única mudança permitida). */
  updatePaymentLineReceived(id: Id, input: { received: number | null; change: number | null }): Promise<OrderPaymentLineRow>;
  /** Confirma a linha (PATCH /orders/:id/payments/:paymentId). */
  confirmPaymentLine(id: Id, input: { confirmedAt: string; confirmedBy: Id }): Promise<OrderPaymentLineRow>;
  deletePaymentLine(id: Id): Promise<void>;
  /** Delete em lote (PUT que descartou linhas não confirmadas). */
  deletePaymentLines(ids: Id[]): Promise<void>;
  /**
   * Denormalizado de exibição em `order`: método único → ele; mais de um →
   * null; e/ou o carimbo de "comanda quitada" (todos os pagamentos confirmados).
   */
  updatePaymentSummary(
    id: Id,
    patch: { paymentMethod?: string | null; paymentConfirmedAt: string | null; paymentConfirmedBy: Id | null },
  ): Promise<void>;
}

export interface StockRepository {
  /** Saldo do ledger = soma de `quantity_delta` (nunca coluna cacheada). */
  balance(productId: Id): Promise<number>;
  /**
   * Grava um movimento no ledger. Devolve o saldo PÓS-movimento (mesmo papel
   * do retorno de `applyStockMovementTx`).
   *
   * ADIÇÃO (Onda 2): `orderId`/`purchaseItemId` — colunas reais do ledger que
   * `addItems`/`deleteItem`/`cancelOrder` (refund por comanda/item) e a
   * compat `applyStockMovementTx` gravam; sem elas o estorno ficaria órfão.
   * O evento `stock.movement` NÃO é emitido aqui — é `session.outbox` no use
   * case (mesma transação), como nos demais eventos.
   */
  recordMovement(input: {
    productId: Id;
    quantityDelta: number;
    type: StockMovementKind;
    unitCost?: number;
    purchaseItemId?: Id | null;
    orderId?: Id | null;
    orderItemId?: Id | null;
    note?: string | null;
    actorId?: Id;
  }): Promise<number>;
  reserveForOrder(orderId: Id): Promise<void>;
  releaseForOrder(orderId: Id): Promise<void>;

  // ---------- ADIÇÕES (Onda 2 — hub de pedidos) ----------
  /** Saldos de vários produtos em uma query (listagem de estoque/produtos). */
  balances(productIds: Id[]): Promise<Map<Id, number>>;
  /** Custo médio móvel vigente de 1 produto (replay do ledger). `fallbackCost` = custo manual do cadastro. */
  movingAverage(productId: Id, fallbackCost: number): Promise<MovingAverageRecord>;
  /** Custo médio de vários produtos em uma query agrupada (listagem/valorização). */
  averageCosts(productIds: Id[]): Promise<Map<Id, MovingAverageRecord>>;
  /** Linhas de `GET /stock`: produtos rastreando estoque + nome de categoria. */
  listTrackedProducts(query: { search?: string; limit: number; offset: number }): Promise<{
    rows: TrackedStockProductRecord[];
    total: number;
  }>;
  /** Linhas de `GET /stock/movements` (produto/usuário resolvidos). */
  listMovements(query: { productId?: Id; limit: number; offset: number }): Promise<{
    rows: StockMovementViewRecord[];
    total: number;
  }>;
  /** Movimentos `sale` vinculados a um item (estorno em `deleteItem` lê o ledger, não flags). */
  listSalesMovementsForItem(orderItemId: Id): Promise<Array<Pick<StockMovementRecord, "quantityDelta">>>;
  /** Movimentos `sale` de uma comanda (estorno integral em `cancelOrder`). */
  listSalesMovementsForOrder(orderId: Id): Promise<
    Array<Pick<StockMovementRecord, "productId" | "orderItemId" | "quantityDelta">>
  >;
}

export interface CashFlowRepository {
  findOpenForUpdate(): Promise<{ id: Id; openedAt: string } | null>;
  open(input: { actorId: Id; openingAmount: number }): Promise<{ id: Id; openedAt: string }>;
  /**
   * Sangria/suprimento. ADIÇÃO (Onda 2): `refOrderId` (coluna real
   * `ref_order_id` — estorno de comanda cancelada rastreia a origem) e o
   * retorno `{ id, amount }` (o audit/outbox do cancelamento publicam
   * `movementId`/`amount` gravados). Refinamento de assinatura sem consumidores
   * anteriores: os demais callers usam Drizzle direto.
   */
  recordMovement(input: {
    drawerId: Id;
    actorId: Id;
    type: CashMovementKind;
    amount: number;
    note?: string;
    refOrderId?: Id | null;
  }): Promise<{ id: Id; amount: number }>;
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
  /** ADIÇÃO (Onda 2): lote por comandas (hidratação da listagem de comandas — uma query só). */
  listByOrderIds(ids: Id[]): Promise<DeliveryRecord[]>;
}

// ---------- repositório de alertas (sino) — ADIÇÃO (Onda 2) ----------

/**
 * ADIÇÃO (Onda 2): persistência da central de alertas. O recorte de
 * visibilidade (audiência por papel/`user:<id>`) é SQL e mora NO ADAPTER — o
 * port só recebe `role`/`userId`, e REST/WS continuam usando a mesma régua de
 * sempre (`visibleTo` original).
 */
export interface AlertRepository {
  /** Insere a linha do alerta com os tokens de audiência (papéis + `user:<id>`). */
  create(input: {
    kind: string;
    title: string;
    body?: string | null;
    orderId?: Id | null;
    channel?: string | null;
    audienceRoles: string[];
  }): Promise<AlertRecord>;
  /** Alertas visíveis ao papel/usuário, mais recentes primeiro. */
  listVisible(query: { role: string; userId?: Id | null; limit: number; unreadOnly?: boolean }): Promise<AlertRecord[]>;
  /** Contadores do sino — do conjunto TODO visível, sem o `unreadOnly` (badge marcaria zero). */
  countVisible(query: { role: string; userId?: Id | null }): Promise<{ total: number; unread: number }>;
  /** Marca como lido só o que o chamador enxerga; devolve quantas linhas mudaram. */
  markRead(query: { role: string; userId?: Id | null; orderId?: Id }): Promise<number>;
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

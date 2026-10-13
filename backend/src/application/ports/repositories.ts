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

/** ADIÇÃO (Onda 3A — catálogo): categoria do produto. */
export interface CategoryRecord {
  id: Id;
  name: string;
  displayOrder: number;
  active: boolean;
  createdAt: string;
}

/** ADIÇÃO (Onda 3A — catálogo): grupo de produção (estação da cozinha). */
export interface KitchenGroupRecord {
  id: Id;
  name: string;
  displayOrder: number;
  active: boolean;
  createdAt: string;
}

export interface ProductRecord {
  id: Id;
  categoryId: Id | null;
  kitchenGroupId: Id | null;
  name: string;
  description: string;
  price: number;
  /** JSON string — o parse para `VariationGroup[]` é do use case (domínio). */
  variations: string;
  /** Curadoria da vitrine pública (§04): produto marcado aparece na seção "Destaques". */
  featured: boolean;
  /** Configuração de estoque (baseline 0001): custo unitário (margem). */
  costPrice: number;
  /** Configuração de estoque: saldo mínimo antes de alertar. */
  lowStockThreshold: number;
  /** Configuração de estoque: se o saldo é rastreado no ledger. */
  trackStock: boolean;
  /** Unidade de medida (baseline 0001), ex.: "un", "kg". */
  unit: string;
  /** Integração iFood (docs/18): habilitado e SKU externo. */
  ifoodEnabled: boolean;
  ifoodSku: string | null;
  active: boolean;
  imagePath: string | null;
  createdAt: string;
  updatedAt: string;
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

// `whatsapp` seguia no enum do banco só por compatibilidade: o canal deixou
// de existir no código, mas pedidos antigos de delivery feitos por ele
// continuam válidos como histórico (relatórios, reimpressão, retomada).
export type OrderChannel = "balcao" | "web" | "ifood";
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
  /**
   * `input.id` presente = update; ausente = create. Create exige
   * `name`/`price` (validados em runtime — o update é parcial,
   * então ambos são opcionais no tipo). Defaults de criação =
   * mesmos de `createProductUsecase`.
   */
  saveProduct(input: Partial<ProductRecord> & { id?: Id }): Promise<ProductRecord>;
  /** Categorias em ordem de exibição (linha inteira — a listagem expõe `createdAt`). */
  listCategories(): Promise<CategoryRecord[]>;
  /** Grupos de produção em ordem de exibição (linha inteira). */
  listKitchenGroups(): Promise<KitchenGroupRecord[]>;

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

  // ---------- ADIÇÕES (Onda 3A — catálogo) ----------
  /** Categoria por id (validação antes de update/delete de produto). */
  findCategoryById(id: Id): Promise<CategoryRecord | null>;
  /** INSERT de categoria (`name`, `displayOrder`). */
  createCategory(input: { name: string; displayOrder?: number }): Promise<CategoryRecord>;
  /** UPDATE parcial de categoria (`name`, `displayOrder`, `active`). */
  updateCategory(id: Id, input: { name?: string; displayOrder?: number; active?: boolean }): Promise<CategoryRecord>;
  /** Exclusão real da categoria; produtos vinculados ficam com `category_id = null`. */
  deleteCategory(id: Id): Promise<void>;
  /** Grupo de produção por id. */
  findKitchenGroupById(id: Id): Promise<KitchenGroupRecord | null>;
  /** INSERT de grupo de produção. */
  createKitchenGroup(input: { name: string; displayOrder?: number }): Promise<KitchenGroupRecord>;
  /** UPDATE parcial de grupo de produção. */
  updateKitchenGroup(id: Id, input: { name?: string; displayOrder?: number; active?: boolean }): Promise<KitchenGroupRecord>;
  /** Exclusão real do grupo; produtos vinculados ficam com `kitchen_group_id = null`. */
  deleteKitchenGroup(id: Id): Promise<void>;
  /** Set de `active` do produto (`product_activated`/`product_deactivated`). */
  setProductActive(id: Id, active: boolean): Promise<ProductRecord>;
  /** UPDATE de `image_path` (foto do produto). */
  saveProductImage(id: Id, filename: string): Promise<ProductRecord>;
  /** Limpa `image_path` (foto removida). */
  clearProductImage(id: Id): Promise<ProductRecord>;
  /** Produtos ativos (menu público) — `active = true`, ordem alfabética. */
  listActiveProducts(): Promise<ProductRecord[]>;
  /** Categorias ativas (menu público) — ordem de exibição. */
  listActiveCategories(): Promise<Array<{ id: Id; name: string }>>;
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

// ---------- ADIÇÕES (Onda 3 — self-service: carrinho e endereços) ----------

/**
 * ADIÇÃO (Onda 3 — self-service): carrinho server-side do cliente
 * (`customer_cart`, baseline 0001), chaveado pelo TELEFONE. Continuação do
 * pedido sem localStorage. O TTL/expiração e o parse do JSON ficam no use case
 * (rascunho); o adapter lê/grava a linha crua (itens = string JSON, como o
 * banco guarda).
 */
export interface CustomerCartRepository {
  /** Linha crua por telefone — null quando não existe (expiração é do use case). */
  findByPhone(phone: Id): Promise<{ items: string; expiresAt: string } | null>;
  /** Upsert por telefone (last-write-wins; o rascunho não tem idempotência). */
  upsert(input: { phone: Id; items: string; updatedAt: string; expiresAt: string }): Promise<void>;
  deleteByPhone(phone: Id): Promise<void>;
}

/**
 * ADIÇÃO (Onda 3 — self-service): endereço de cliente (`customer_address`).
 * O CEP cru (8 dígitos, já normalizado pelo use case), o limite de 3 por
 * cliente e a promoção de "padrão" são regras de use case — o adapter só
 * persiste as colunas reais (sem `latitude`/`longitude`, que não são
 * serializados hoje).
 */
export interface CustomerAddressRecord {
  id: Id;
  customerId: Id;
  label: string | null;
  cep: string | null;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string | null;
  reference: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface CustomerAddressRepository {
  findById(id: Id): Promise<CustomerAddressRecord | null>;
  /** Todos os endereços do cliente (mesma consulta sem ordenação do `findMany` original). */
  listByCustomer(customerId: Id): Promise<CustomerAddressRecord[]>;
  /** Mais antigo do cliente (`createdAt ASC`, LIMIT 1) — reassume o padrão na exclusão. */
  findOldestByCustomer(customerId: Id): Promise<CustomerAddressRecord | null>;
  create(input: {
    customerId: Id;
    label?: string | null;
    cep?: string | null;
    street: string;
    number: string;
    complement?: string | null;
    neighborhood: string;
    city: string;
    state?: string | null;
    reference?: string | null;
    isDefault: boolean;
  }): Promise<CustomerAddressRecord>;
  /** Zera `is_default` de todos os endereços do cliente (um padrão por cliente). */
  clearDefaults(customerId: Id): Promise<void>;
  setDefault(id: Id): Promise<void>;
  delete(id: Id): Promise<void>;
}

// ---------- ADIÇÕES (Onda 3 — contexto delivery) ----------

/**
 * ADIÇÃO (Onda 3): escrita de `store_settings` dentro do use case. A LEITURA
 * continua no effect port `StoreSettingsReader` (mesmo caminho já adotado por
 * `order.usecases` e self-service); aqui entra só o que nasce na janela
 * transacional — a geocodificação do endereço do restaurante.
 */
export interface StoreSettingsRepository {
  /** Grava as coordenadas do estabelecimento (singleton). */
  updateRestaurantCoordinates(input: { latitude: number; longitude: number }): Promise<void>;
}

/**
 * ADIÇÃO (Onda 3): cache PERSISTENTE de reverse geocoding (`geocoding_cache`).
 *
 * Distinto do `TenantCache` (effects): aquele é cache de processo por schema e
 * guarda derivados; este é a tabela `geocoding_cache`, que o cálculo público de
 * entrega lê/grava para não bater no Nominatim a cada request. A checagem de
 * expiração (`expires_at`) fica no use case — o adapter devolve a linha crua.
 */
export interface GeocodingCacheRepository {
  find(cacheKey: string): Promise<{ response: string; expiresAt: string } | null>;
  /** Upsert por `cache_key` (mesma chave já normalizada pelo use case). */
  upsert(input: { cacheKey: string; response: string; expiresAt: string }): Promise<void>;
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

/** Linha de `audit_log` já enriquecida com o nome do usuário (join com `user`). */
export interface AuditLogEntry {
  id: Id;
  userId: Id;
  userName: string;
  action: string;
  orderId: Id | null;
  details: Json;
  createdAt: string;
}

/**
 * Leitura da trilha de auditoria (`GET /audit-log`). A escrita continua em
 * `AuditWriter.record` — aqui é só a consulta paginada (Onda 3B).
 */
export interface AuditRepository {
  list(input: { orderId?: Id; limit: number; offset: number }): Promise<{ data: AuditLogEntry[]; total: number }>;
}

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

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

/** ADIÇÃO (Onda 3C — store-settings): tipo de chave Pix (espelha o enum `pix_key_type`). */
export type PixKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

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
  /**
   * ADIÇÃO (Onda auth — login.usecase): estado de tentativas de login. O use
   * case lê para decidir o lock e grava (incrementa/trava ou zera) por
   * `setLoginState`; o record NÃO era exposto a apresentação.
   */
  failedAttempts: number;
  /** ISO 8601 UTC; `null` quando a conta não está travada. */
  lockedUntil: string | null;
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
// Entra no union porque a retomada do self-service (`getActiveSelfServiceOrder
// ByPhone`) lê `channel IN ('whatsapp', 'web')` para não esconder pedido antigo.
export type OrderChannel = "balcao" | "web" | "whatsapp";
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

  // ---------- ADIÇÕES (Onda 3 — self-service) ----------
  /**
   * Lote de produtos por ids (validação de variações do checkout): o
   * `checkout` confere cada linha contra `variations`/`name` do produto —
   * inexistente fica de fora e `addItems` responde 404 depois.
   */
  findProductsByIds(ids: Id[]): Promise<ProductRecord[]>;

  // ---------- ADIÇÃO (Onda financeiro — compras) ----------
  /**
   * Espelha o custo médio móvel vigente em `product.cost_price` (display).
   * O ledger continua a fonte da verdade; a coluna é leitura conveniente —
   * mesma disciplina do `payment_method` denormalizado.
   */
  setCostPrice(productId: Id, costPrice: number): Promise<void>;
}

export interface CustomerRepository {
  findById(id: Id): Promise<CustomerRecord | null>;
  findByPhone(phone: string): Promise<CustomerRecord | null>;
  list(query: PageQuery & { search?: string; active?: boolean }): Promise<Page<CustomerRecord>>;
  /** `input.id` presente = update; ausente = create. Normalização (phone/email/cpf) fica no use case. */
  save(input: Partial<CustomerRecord> & Pick<CustomerRecord, "name">): Promise<CustomerRecord>;
  /** Soft-delete (seta `active=false`) — cliente tem histórico, nunca é apagado. */
  delete(id: Id): Promise<void>;
  /** ADIÇÃO (Onda 2): lote por ids (hidratação da listagem de comandas — sem N+1). */
  findByIds(ids: Id[]): Promise<CustomerRecord[]>;

  // ---------- ADIÇÕES (Onda 3C — customer.usecases) ----------
  /** Cliente por email exato (unicidade `uq_customer_email` — 400 no use case). */
  findByEmail(email: string): Promise<CustomerRecord | null>;
  /** Cliente por CPF exato (unicidade `uq_customer_cpf` — 400 no use case). */
  findByCpf(cpf: string): Promise<CustomerRecord | null>;
  /**
   * Busca leve do balcão (abrir comanda com cliente): só ATIVOS, ordem
   * alfabética, LIMIT 20, sem email — a manutenção completa é a `list`.
   */
  searchLight(search?: string): Promise<Array<Pick<CustomerRecord, "id" | "name" | "phone">>>;
  /**
   * Contagem de endereços por cliente em uma query agrupada. `customerIds`
   * vazio devolve mapa vazio; o mapa pode não ter a chave de um cliente sem
   * endereços (o use case trata como 0).
   */
  countAddressesByCustomer(customerIds: Id[]): Promise<Map<Id, number>>;
}

export interface UserRepository {
  findById(id: Id): Promise<UserRecord | null>;
  /** Login por id, telefone ou email (case-insensitive) — o use case de login valida PIN/lock depois. */
  findByLogin(login: string): Promise<UserRecord | null>;
  /**
   * Usuários ativos em ordem alfabética (`GET /auth/users` — tela de seleção do
   * login). ADIÇÃO (Onda auth): `photoPath` entra para o serializador do use
   * case montar a URL pública (o record não traz apresentação pronta).
   */
  listActive(): Promise<Array<Pick<UserRecord, "id" | "name" | "role" | "photoPath">>>;
  /** `input.id` presente = update; ausente = create (exige `pinHash` já argon2-hasheado pelo use case). */
  save(input: Partial<UserRecord> & Pick<UserRecord, "name" | "role">): Promise<UserRecord>;
  /** ADIÇÃO (Onda 3 — self-service): lote por ids (entregadores da listagem de entregas, sem N+1). */
  findByIds(ids: Id[]): Promise<UserRecord[]>;
  /** ADIÇÃO (Onda 3 — self-service): usuários de um papel (`GET /manager/couriers` — inclui inativos). */
  listByRole(role: UserRole): Promise<UserRecord[]>;

  // ---------- ADIÇÕES (Onda auth — user.usecases) ----------
  /** Lista completa, ordem alfabética (`GET /users`, manager-only). */
  list(): Promise<UserRecord[]>;
  /** Usuário por email EXATO (unicidade não-índice — a validação é do use case). */
  findByEmail(email: string): Promise<UserRecord | null>;
  /**
   * Estado de tentativas de login (colunas `failed_attempts`/`locked_until`).
   * Falha incrementa/trava; sucesso zera. Sem `updatedAt` — mesma régua de
   * `countFailedAttempt`/reset do login original.
   */
  setLoginState(id: Id, state: { failedAttempts: number; lockedUntil: string | null }): Promise<void>;
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

  // ---------- ADIÇÕES (Onda 3 — self-service) ----------
  /** Comandas em lote por ids (hidratação das listagens de entrega, uma query só). */
  listRowsByIds(ids: Id[]): Promise<OrderRow[]>;
  /**
   * Comanda em aberto mais recente de um cliente num conjunto de canais —
   * retomada do self-service (`getActiveSelfServiceOrderByPhone`). `channels`
   * inclui o legado `whatsapp` para não esconder pedido antigo.
   */
  findLatestOpenByCustomer(customerId: Id, channels: OrderChannel[]): Promise<OrderRow | null>;
  /**
   * Marca como `delivered` todos os itens pendentes (não `delivered`/`cancelled`)
   * da comanda — efeito de `closeOrderAfterDelivery`. A comanda de entrega não
   * tem garçom servindo mesa, então nenhum item chega a "delivered" sozinho.
   */
  markItemsDelivered(orderId: Id): Promise<void>;

  // ---------- ADIÇÕES (Onda 3C — customer.usecases) ----------
  /**
   * Comandas ABERTAS do cliente, mais antigas primeiro, com `tableNumber`
   * resolvida por LEFT JOIN — bloco "comanda em aberto" do detalhe do cliente.
   */
  listOpenByCustomer(customerId: Id): Promise<CustomerOpenOrderRecord[]>;
  /**
   * Histórico paginado do cliente: `closedAt DESC NULLS LAST, openedAt DESC`
   * + contagem do conjunto filtrado, com `tableNumber` por LEFT JOIN. `from`/`to`
   * já chegam RESOLVIDOS (bordas do dia local da loja) — o use case valida e
   * converte `YYYY-MM-DD` com o `tz` antes de chamar.
   */
  listHistoryByCustomer(
    customerId: Id,
    query: { limit: number; offset: number; from?: string; to?: string },
  ): Promise<Page<CustomerOrderHistoryRecord>>;
  /**
   * Comandas FECHADAS do cliente com `closedAt` em `[from, to]` (bordas já
   * resolvidas) — só `id`/`closedAt`/`deliveryFee`, que é o que a série de
   * consumo agrega em JS (mesma régua da visão geral).
   */
  listClosedByCustomerBetween(
    customerId: Id,
    from: string,
    to: string,
  ): Promise<Array<{ id: Id; closedAt: string | null; deliveryFee: number | null }>>;
  /**
   * Total e contagem de itens por comanda, numa query agrupada. Mesmo cálculo
   * de `computeOrderTotal` (soma `unit_price × quantity` do snapshot, excluindo
   * `cancelled`); `itemCount` soma `quantity`, não linhas.
   */
  aggregateItemsByOrders(orderIds: Id[]): Promise<Map<Id, { total: number; itemCount: number }>>;

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
  /**
   * ADIÇÃO (Onda financeiro — valorização): produtos rastreando estoque para
   * `GET /inventory/value`. Mesma forma do `listTrackedProducts`, mas com a
   * busca `lower(name) LIKE lower(%term%)` do `inventoryValuationUsecase`
   * original (sem `unaccent`) — a valorização preserva a régua exata.
   */
  listValuationProducts(query: { search?: string; limit: number; offset: number }): Promise<{
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

// ---------- ADIÇÃO (Onda cash-flow): records de gaveta e movimento ----------

/** Linha completa de `cash_drawer` (todas as colunas do schema). */
export interface CashDrawerRecord {
  id: Id;
  status: "open" | "closed";
  openedAt: string;
  openedBy: Id;
  openingAmount: number;
  note: string | null;
  closedAt: string | null;
  closedBy: Id | null;
  closingExpected: number | null;
  closingCounted: number | null;
  closingDifference: number | null;
  closingNote: string | null;
  /** JSON string (mesmo formato do banco) — o parse é do use case. */
  closingDenominations: string | null;
  closingJustification: string | null;
  closingApprovedBy: Id | null;
}

/** Linha de `cash_drawer_movement`. */
export interface CashMovementRecord {
  id: Id;
  drawerId: Id;
  type: CashMovementKind;
  amount: number;
  note: string | null;
  refOrderId: Id | null;
  createdBy: Id;
  createdAt: string;
  category: string;
}

/**
 * ADIÇÃO (Onda cash-flow): pagamento em dinheiro confirmado na janela da
 * sessão — a fonte das ENTRADAS do caixa (`order_payment` é a fonte da
 * verdade). Mesma query de `cashPaymentsBetween`: method='cash' AND confirmed
 * AND `confirmed_at` BETWEEN [from, to], sem JOIN (o resumo só soma/contagem).
 */
export interface CashPaymentRecord {
  orderId: Id;
  amount: number;
  received: number | null;
  change: number | null;
  confirmedAt: string | null;
}

/**
 * ADIÇÃO (Onda cash-flow): linha do detalhe de vendas em dinheiro
 * (`GET /cash-drawer/:id`) — mesmo JOIN de `order_payment` × `order` ×
 * `restaurant_table` da query original; o rótulo "Mesa N"/tabLabel é montado
 * pelo use case.
 */
export interface CashSaleRecord {
  orderId: Id;
  tabLabel: string | null;
  tableNumber: string | null;
  amount: number;
  received: number | null;
  change: number | null;
  confirmedAt: string | null;
}

/**
 * ADIÇÃO (Onda cash-flow): persistência da gaveta — a ONDA 2 tinha só o
 * mínimo para `order`/`refund` (findOpenForUpdate/open/recordMovement); a
 * migração de `cash-flow.usecases` completou as leituras (current/detalhe/
 * listagem/resumo) e o fechamento.
 */
export interface CashFlowRepository {
  /** Gaveta aberta SEM lock (`GET /cash-drawer/current`). */
  findOpen(): Promise<CashDrawerRecord | null>;
  /**
   * SELECT ... FOR UPDATE da gaveta aberta (mesma trava de linha de
   * `findOpenDrawerTxForUpdate`): sangria/suprimento/fechamento e o pagamento
   * em dinheiro confirmado validam o saldo sob o lock de linha.
   */
  findOpenForUpdate(): Promise<CashDrawerRecord | null>;
  /**
   * Abre a gaveta. A checagem "já existe aberta" + o índice único parcial
   * `uq_cash_drawer_single_open` replicam `openCashDrawerUsecase` (a corrida em
   * duas requisições vira o mesmo 409, não uma segunda gaveta). O `openedAt`
   * chega ISO 8601 UTC explícito (comparação lexicográfica com
   * `order_payment.confirmed_at`); audit/outbox são do use case.
   */
  open(input: {
    actorId: Id;
    openingAmount: number;
    note?: string | null;
    openedAt: string;
  }): Promise<CashDrawerRecord>;
  /**
   * Sangria/suprimento. ADIÇÃO (Onda 2): `refOrderId` (coluna real
   * `ref_order_id` — estorno de comanda cancelada rastreia a origem) e o
   * retorno com id/amount (o audit/outbox do cancelamento publicam
   * `movementId`/`amount` gravados). ADIÇÃO (Onda cash-flow): `category`
   * (default "outros" do schema quando ausente) e o retorno vira a linha
   * completa (o use case serializa `note`/`category`/`createdAt`).
   */
  recordMovement(input: {
    drawerId: Id;
    actorId: Id;
    type: CashMovementKind;
    amount: number;
    note?: string;
    refOrderId?: Id | null;
    category?: string;
  }): Promise<CashMovementRecord>;
  /**
   * Fechamento: grava status + os campos de conferência JÁ calculados pelo use
   * case (`closing_expected`/`counted`/`difference`/denominações/justificativa/
   * aprovador) e devolve a linha atualizada.
   */
  close(input: {
    drawerId: Id;
    closedBy: Id;
    closedAt: string;
    closingExpected: number;
    closingCounted: number;
    closingDifference: number;
    closingNote: string | null;
    closingDenominations: string | null;
    closingJustification: string | null;
    closingApprovedBy: string | null;
  }): Promise<CashDrawerRecord>;
  /** Gaveta por id (`GET /cash-drawer/:id`). */
  findById(id: Id): Promise<CashDrawerRecord | null>;
  /** Listagem paginada `openedAt DESC` (`GET /cash-drawer`). */
  list(query: PageQuery): Promise<CashDrawerRecord[]>;
  /**
   * Sessões que INTERSECTAM `[from, to]`: não fecharam antes de `from`
   * (`closed_at` NULL conta) nem abriram depois de `to`, `openedAt DESC`
   * (`GET /cash-drawer/summary`).
   */
  listIntersecting(from: string, to: string): Promise<CashDrawerRecord[]>;
  /** Movimentos da gaveta, mais recentes primeiro (`createdAt DESC`). */
  listMovements(drawerId: Id): Promise<CashMovementRecord[]>;
  /** Pagamentos em dinheiro confirmados na janela (resumo de saldo). */
  listCashPaymentsBetween(from: string, to: string): Promise<CashPaymentRecord[]>;
  /** Vendas em dinheiro confirmadas na janela, com mesa resolvida (detalhe). */
  listCashSalesBetween(from: string, to: string): Promise<CashSaleRecord[]>;
}

// ---------- ADIÇÕES (Onda financeiro — compras, estornos e liquidações) ----------

/**
 * ADIÇÃO (Onda financeiro — compras): fornecedor (`supplier`). O trim/merge dos
 * campos é do use case; o adapter grava o valor resolvido.
 */
export interface SupplierRecord {
  id: Id;
  name: string;
  phone: string | null;
  taxId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierRepository {
  /** Lista (opcionalmente só ativos) `name ASC` + total. */
  list(query: { activeOnly?: boolean; limit: number; offset: number }): Promise<Page<SupplierRecord>>;
  findById(id: Id): Promise<SupplierRecord | null>;
  create(input: { name: string; phone?: string | null; taxId?: string | null }): Promise<SupplierRecord>;
  /** UPDATE dos campos JÁ resolvidos pelo use case (merge + trim são domínio). */
  update(
    id: Id,
    input: { name: string; phone: string | null; taxId: string | null; active: boolean },
  ): Promise<SupplierRecord>;
}

/** ADIÇÃO (Onda financeiro — compras): linha da listagem (`GET /purchases`). */
export interface PurchaseListItemRecord {
  id: Id;
  invoiceNumber: string | null;
  issuedOn: string | null;
  supplierId: Id | null;
  supplierName: string | null;
  note: string | null;
  total: number;
  createdByName: string | null;
  createdAt: string;
  itemCount: number;
}

/** ADIÇÃO (Onda financeiro — compras): cabeçalho do detalhe (`GET /purchases/:id`). */
export interface PurchaseDetailRecord {
  id: Id;
  invoiceNumber: string | null;
  issuedOn: string | null;
  note: string | null;
  total: number;
  supplierId: Id | null;
  supplierName: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** ADIÇÃO (Onda financeiro — compras): linha do detalhe, com nome do produto. */
export interface PurchaseItemViewRecord {
  id: Id;
  productId: Id;
  productName: string | null;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  batchNo: string | null;
  expiryDate: string | null;
}

export interface PurchaseRepository {
  findById(id: Id): Promise<PurchaseRecord | null>;
  create(input: { supplierId?: Id | null; actorId: Id }): Promise<PurchaseRecord>;
  addItem(input: { purchaseId: Id; productId: Id; quantity: number; unitCost: number }): Promise<void>;
  finalize(id: Id): Promise<void>;

  // ---------- ADIÇÃO (Onda financeiro — compras) ----------
  /** INSERT do documento completo (`createPurchaseUsecase`) com todos os cabeçalhos. */
  createDocument(input: {
    supplierId?: Id | null;
    invoiceNumber?: string | null;
    issuedOn?: string | null;
    note?: string | null;
    total: number;
    actorId: Id;
  }): Promise<PurchaseRecord>;
  /** INSERT da linha (`lineTotal` já arredondado pelo use case). Devolve id + lineTotal. */
  insertItem(input: {
    purchaseId: Id;
    productId: Id;
    quantity: number;
    unitCost: number;
    lineTotal: number;
    batchNo?: string | null;
    expiryDate?: string | null;
    actorId: Id;
  }): Promise<{ id: Id; lineTotal: number }>;
  /** Listagem (`createdAt DESC`, fornecedor/usuário resolvidos, contagem de linhas) + total. */
  list(query: { limit: number; offset: number }): Promise<Page<PurchaseListItemRecord>>;
  /** Cabeçalho do detalhe (fornecedor/usuário resolvidos) ou null. */
  findDetail(id: Id): Promise<PurchaseDetailRecord | null>;
  /** Linhas do documento com nome do produto (`products.name ASC, purchase_item.seq ASC`). */
  listItems(id: Id): Promise<PurchaseItemViewRecord[]>;
}

/**
 * ADIÇÃO (Onda financeiro — estornos do balcão, Bloco 4). Estorno rastreável:
 * a venda estornada vira linha negativa no relatório, nunca desaparece. A régua
 * de valores/status é do use case; o adapter lê/grava `order_refund` e agrega.
 */
export interface RefundRecord {
  id: Id;
  orderId: Id;
  orderPaymentId: Id;
  amount: number;
  method: PaymentMethodKind;
  reason: string;
  status: string;
  requestedBy: Id;
  requestedAt: string;
  settledAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface RefundRepository {
  /**
   * Soma dos estornos ATIVOS (`requested`+`settled`) de uma linha de pagamento —
   * teto do `refundOrderPaymentUsecase` (o round2 é do use case).
   */
  sumActiveByPayment(paymentId: Id): Promise<number>;
  create(input: {
    id: Id;
    orderId: Id;
    orderPaymentId: Id;
    amount: number;
    method: PaymentMethodKind;
    reason: string;
    status: string;
    requestedBy: Id;
    requestedAt: string;
    settledAt: string | null;
    notes: string | null;
  }): Promise<RefundRecord>;
  /** Estornos do pedido, em ordem de criação (`createdAt ASC`). */
  listByOrder(orderId: Id): Promise<RefundRecord[]>;
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

  // ---------- ADIÇÕES (Onda 3 — self-service) ----------
  /** INSERT da entrega do checkout self-service (status inicial `awaiting_courier`). */
  create(input: {
    orderId: Id;
    address: string;
    status: DeliveryStatus;
    distanceKm: number | null;
    estimatedMinutes: number;
  }): Promise<DeliveryRecord>;
  /**
   * Todas as entregas (sem paginação), opcionalmente filtradas por status,
   * mais recentes primeiro — `GET /manager/deliveries`.
   */
  listAll(statuses?: DeliveryStatus[]): Promise<DeliveryRecord[]>;
  /**
   * Fila do entregador (opcionalmente filtrada por status), mais antigas
   * primeiro — `GET /courier/deliveries`.
   */
  listForCourier(courierId: Id, statuses?: DeliveryStatus[]): Promise<DeliveryRecord[]>;
  /** Falha da entrega (`status = failed` + `notes = reason`) — `PATCH .../fail`. */
  fail(id: Id, reason: string): Promise<DeliveryRecord>;
  /**
   * Edição de status do gerente: grava `status` + `deliveredAt`/`notes` já
   * resolvidos pelo use case, PRESERVANDO `dispatchedAt` (o gerente não
   * carimba a saída; quem faz isso é o `dispatch` do entregador).
   */
  setStatus(
    id: Id,
    patch: { status: DeliveryStatus; deliveredAt: string | null; notes: string | null },
  ): Promise<DeliveryRecord>;
  /** Entrega em rota AGORA do entregador (guard do `POST /courier/location`). */
  findActiveForCourier(courierId: Id): Promise<DeliveryRecord | null>;
}

/**
 * ADIÇÃO (Onda 3 — self-service): última posição do entregador
 * (`courier_location`, migration 0003). Uma linha por courier; `upsert` é
 * last-write-wins e `listOnRoute` parte da `delivery` em rota (fonte da
 * verdade do "em rota"), não da tabela de posições.
 */
export interface CourierLocationRecord {
  courierId: Id;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  updatedAt: string;
}

export interface CourierLocationRepository {
  /** Upsert por courier (a última posição é a única que interessa) e devolve a linha gravada. */
  upsert(input: {
    courierId: Id;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    updatedAt: string;
  }): Promise<CourierLocationRecord>;
  /**
   * Última posição dos entregadores com entrega em rota agora, com
   * nome/basename da foto resolvidos — `GET /manager/deliveries/locations`.
   * `photoPath` sai CRU (basename); a URL pública é do use case.
   */
  listOnRoute(): Promise<
    Array<{
      courierId: Id;
      courierName: string | null;
      photoPath: string | null;
      latitude: number;
      longitude: number;
      updatedAt: string;
    }>
  >;
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
  /**
   * ADIÇÃO (Onda 3 — entrega): georreferência usada só para o marker de
   * destino no mapa do entregador/gerente. Não é serializada na API.
   */
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  createdAt: string;
}

export interface CustomerAddressRepository {
  findById(id: Id): Promise<CustomerAddressRecord | null>;
  /** Todos os endereços do cliente (mesma consulta sem ordenação do `findMany` original). */
  listByCustomer(customerId: Id): Promise<CustomerAddressRecord[]>;
  /**
   * ADIÇÃO (Onda 3 — entrega): endereços de vários clientes em uma query — o
   * marker de destino do mapa resolve o endereço padrão por cliente (sem N+1).
   */
  listByCustomers(customerIds: Id[]): Promise<CustomerAddressRecord[]>;
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
 * ADIÇÃO (Onda 3C — customer.usecases): comanda em aberto do cliente no bloco
 * de detalhe — `tableNumber` resolvida por LEFT JOIN com `restaurant_table`.
 */
export interface CustomerOpenOrderRecord {
  id: Id;
  status: OrderStatus;
  openedAt: string;
  tabLabel: string | null;
  deliveryFee: number | null;
  tableNumber: string | null;
}

/**
 * ADIÇÃO (Onda 3C — customer.usecases): linha do histórico paginado do cliente
 * (`GET /customers/:id/orders`) — `tableNumber` resolvida por LEFT JOIN.
 */
export interface CustomerOrderHistoryRecord {
  id: Id;
  status: OrderStatus;
  openedAt: string;
  closedAt: string | null;
  tabLabel: string | null;
  paymentMethod: string | null;
  deliveryFee: number | null;
  tableNumber: string | null;
}

/**
 * ADIÇÃO (Onda 3C — store-settings): linha completa do singleton
 * `store_settings` (todas as colunas, `pixKeyType` como union do enum).
 */
export interface StoreSettingsRow {
  id: Id;
  merchantName: string;
  merchantCity: string;
  logoPath: string | null;
  brandColor: string;
  pixKey: string;
  pixKeyType: PixKeyType;
  usesTables: boolean;
  kitchenEnabled: boolean;
  usesDelivery: boolean;
  inventoryEnabled: boolean;
  purchaseEnabled: boolean;
  printerEnabled: boolean;
  printerAutoPrint: boolean;
  /** JSON string (mesmo formato do banco) — o parse para `string[]` é do use case. */
  enabledPaymentMethods: string;
  kitchenPrepWarnMin: number;
  kitchenPrepUrgentMin: number;
  kitchenPickupUrgentMin: number;
  deliveryFee: number;
  restaurantLat: number | null;
  restaurantLong: number | null;
  freeDeliveryMin: number;
  /** JSON string (mesmo formato do banco) — o parse para faixas é do use case. */
  deliveryFeeTiers: string;
  deliveryPrepMinutes: number;
  minutesPerKm: number;
  cashClosingTolerance: number;
  cashClosingRequireApprovalAbove: number;
  cashHighValueThreshold: number;
}

/**
 * ADIÇÃO (Onda 3C — store-settings): input do `PUT /store-settings` — o
 * `pixKey` já chega CANÔNICO (o use case roda `canonicalizePixKey` antes) e os
 * campos JSON chegam como estrutura (o adapter serializa).
 */
export interface StoreSettingsUpdateInput {
  merchantName: string;
  merchantCity: string;
  brandColor: string;
  pixKey: string;
  pixKeyType: PixKeyType;
  usesTables: boolean;
  kitchenEnabled: boolean;
  usesDelivery: boolean;
  inventoryEnabled: boolean;
  purchaseEnabled: boolean;
  printerEnabled: boolean;
  printerAutoPrint: boolean;
  enabledPaymentMethods: string[];
  kitchenPrepWarnMin: number;
  kitchenPrepUrgentMin: number;
  kitchenPickupUrgentMin: number;
  deliveryFee: number;
  restaurantLat?: number | null;
  restaurantLong?: number | null;
  freeDeliveryMin?: number;
  deliveryFeeTiers?: Array<{ maxKm: number; fee: number }>;
  deliveryPrepMinutes?: number;
  minutesPerKm?: number;
}

/**
 * ADIÇÃO (Onda 3): escrita de `store_settings` dentro do use case. A LEITURA
 * continua no effect port `StoreSettingsReader` (mesmo caminho já adotado por
 * `order.usecases` e self-service); aqui entra o que nasce na janela
 * transacional — a geocodificação do endereço do restaurante e, a partir da
 * Onda 3C, TODO o singleton (o `PUT /store-settings` e o logo).
 */
export interface StoreSettingsRepository {
  /** Grava as coordenadas do estabelecimento (singleton). */
  updateRestaurantCoordinates(input: { latitude: number; longitude: number }): Promise<void>;
  /** ADIÇÃO (Onda 3C): linha completa do singleton — `null` quando não existe. */
  findSingleton(): Promise<StoreSettingsRow | null>;
  /**
   * ADIÇÃO (Onda 3C): UPDATE de todos os campos do input (`PUT /store-settings`),
   * devolvendo a linha atualizada.
   */
  update(input: StoreSettingsUpdateInput): Promise<StoreSettingsRow>;
  /** ADIÇÃO (Onda 3C): grava/limpa `logo_path` (upload/remoção do logo), devolvendo a linha atualizada. */
  setLogoPath(filename: string | null): Promise<StoreSettingsRow>;
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

// ---------- ADIÇÃO (Onda provisioning — docs/21): provisionamento de aparelhos ----------

/**
 * ADIÇÃO (device provisioning): chave de provisionamento (`provisioning_key`).
 * O SEGREDO existe em texto puro só na resposta da geração; no banco vive o
 * hash argon2 (`codeHash`) e, para exibição, o sufixo `codeHint`.
 */
export interface ProvisioningKeyRecord {
  id: Id;
  userId: Id;
  codeHash: string;
  codeHint: string;
  createdBy: Id | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningKeyRepository {
  /** Revoga a chave ativa do usuário (rotação): `WHERE user_id = ? AND revoked_at IS NULL`. */
  revokeActive(userId: Id, at: string): Promise<void>;
  /**
   * Cria a chave. O `ON CONFLICT DO NOTHING` do índice único parcial
   * `uq_provisioning_key_active` cobre a corrida de dois gerentes: o perdedor
   * recebe `null` (sem código) em vez de estourar 500.
   */
  create(input: {
    userId: Id;
    codeHash: string;
    codeHint: string;
    createdBy: Id | null;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<ProvisioningKeyRecord | null>;
  /**
   * Chaves "vivas" para o match por verificação: não revogadas (ou revogadas
   * DEPOIS de `cutoff`) e não expiradas (ou expiradas depois de `cutoff`). O
   * `cutoff` é a janela de graça para responder `revoked` em vez de `invalid`.
   */
  listCandidates(cutoff: string): Promise<ProvisioningKeyRecord[]>;
}

/**
 * ADIÇÃO (device provisioning): aparelho provisionado (`user_device`).
 * `active`/`revokedAt` são o ciclo de vida; `deviceSecretHash` é argon2 do
 * device token (texto puro só na resposta do exchange/refresh).
 */
export interface UserDeviceRecord {
  id: Id;
  userId: Id;
  provisioningKeyId: Id | null;
  label: string | null;
  platform: string;
  appProfile: string;
  deviceSecretHash: string;
  active: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserDeviceRepository {
  /** Revoga TODOS os aparelhos ativos do usuário (cascata da desativação); devolve quantos. */
  revokeAll(userId: Id, at: string): Promise<number>;
  create(input: {
    userId: Id;
    provisioningKeyId: Id | null;
    label: string | null;
    platform: string;
    appProfile: string;
    deviceSecretHash: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<UserDeviceRecord>;
  findById(id: Id): Promise<UserDeviceRecord | null>;
  /**
   * Rotaciona o device token com LOCK OTIMISTA de ciclo de vida: `WHERE id = ?
   * AND active = true`. `false` = nenhuma linha (aparelho revogado em corrida).
   */
  rotateToken(id: Id, patch: { deviceSecretHash: string; lastSeenAt: string; updatedAt: string }): Promise<boolean>;
  /** Atualiza `last_seen_at`/`updated_at` só se o aparelho segue ativo (login com deviceId). */
  touchLastSeen(id: Id, at: string): Promise<void>;
  /** Aparelhos do usuário, mais recentes primeiro (`created_at DESC`). */
  listByUser(userId: Id): Promise<UserDeviceRecord[]>;
  /** Revoga um aparelho (`active = false` + `revoked_at`) — `WHERE active = true`. */
  revoke(id: Id, at: string): Promise<void>;
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

// ---------- relatórios gerenciais — ADIÇÃO (Onda 3D) ----------

/**
 * ADIÇÃO (Onda 3D — relatórios gerenciais): comanda fechada com mesa e cliente
 * resolvidos (LEFT JOINs com `restaurant_table` e `customer`) — a base de
 * `GET /reports/sales`.
 */
export interface ReportClosedOrderRow {
  id: Id;
  closedAt: string | null;
  paymentMethod: string | null;
  tableId: Id | null;
  tableNumber: string | null;
  customerId: Id | null;
  customerName: string | null;
  tabLabel: string | null;
  deliveryFee: number | null;
}

/** ADIÇÃO (Onda 3D): linha de `order_item` do relatório de vendas — os totais por comanda/produto são agregados em JS (mesma conta de `computeOrderTotal`). */
export interface ReportItemRow {
  orderId: Id;
  productId: Id;
  unitPrice: number;
  costPrice: number;
  quantity: number;
  status: OrderItemStatus;
}

/** ADIÇÃO (Onda 3D): estorno `settled` por comanda (faturamento líquido do Bloco 4). */
export interface ReportRefundRow {
  orderId: Id;
  amount: number;
}

/** ADIÇÃO (Onda 3D): linha de `order_payment` do relatório de vendas (fracionamento por forma). */
export interface ReportPaymentRow {
  orderId: Id;
  method: string | null;
  amount: number;
  change: number | null;
}

/** ADIÇÃO (Onda 3D): comanda fechada no intervalo — o mínimo que a visão geral e o relatório de entregas consomem. */
export interface ReportOrderSummaryRow {
  id: Id;
  closedAt: string | null;
  deliveryFee: number | null;
}

/** ADIÇÃO (Onda 3D): soma de `unit_price × quantity` por comanda (sem cancelados), numa query agrupada. */
export interface ReportOrderItemsTotalRow {
  orderId: Id;
  total: number;
}

/** ADIÇÃO (Onda 3D): entrega com comanda e entregador resolvidos (innerJoin `delivery`×`order` + leftJoin `user`) — `GET /reports/deliveries`. */
export interface ReportDeliveryRow {
  orderId: Id;
  status: DeliveryStatus;
  courierId: Id | null;
  courierName: string | null;
  deliveryFee: number | null;
  estimatedMinutes: number | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
}

/**
 * ADIÇÃO (Onda 3D — relatórios gerenciais): leituras de `GET /reports/sales`,
 * `/reports/overview` e `/reports/deliveries`. O adapter replica os MESMOS
 * JOINs/filtros das queries originais (janela de 30 dias default, bordas do dia
 * LOCAL já resolvidas pelo use case via `dayStart`/`dayEnd`); a agregação em JS
 * (totais por comanda, buckets por período) continua nos use cases.
 */
export interface ReportRepository {
  /** Comandas fechadas com mesa/cliente resolvidos; sem `dateFrom`/`dateTo` vale a janela default de 30 dias (mesma régua do original). */
  listClosedOrders(input: { dateFrom?: string; dateTo?: string }): Promise<ReportClosedOrderRow[]>;
  /** Comandas que contêm o produto (`SELECT DISTINCT order_id` de `order_item`) — filtro `productId` do relatório de vendas. */
  listOrderIdsByProduct(productId: Id): Promise<Id[]>;
  /** Itens das comandas (snapshot de preço/custo + quantidade + status) — `orderIds` vazio devolve `[]`. */
  listOrderItems(orderIds: Id[]): Promise<ReportItemRow[]>;
  /** Estornos `settled` das comandas — `orderIds` vazio devolve `[]`. */
  listSettledRefunds(orderIds: Id[]): Promise<ReportRefundRow[]>;
  /** Nomes dos produtos (hidratação do `byProduct`) — `productIds` vazio devolve `[]`. */
  listProductNames(productIds: Id[]): Promise<Array<{ id: Id; name: string }>>;
  /** Linhas de `order_payment` das comandas (fracionamento por forma) — `orderIds` vazio devolve `[]`. */
  listOrderPayments(orderIds: Id[]): Promise<ReportPaymentRow[]>;
  /** Comandas fechadas com `closedAt` em `[from, to]` — bordas do dia LOCAL já resolvidas pelo use case (visão geral e entregas). */
  listClosedOrdersBetween(from: string, to: string): Promise<ReportOrderSummaryRow[]>;
  /** Soma de `unit_price × quantity` por comanda, excluindo `cancelled`, numa query agrupada — `orderIds` vazio devolve `[]`. */
  listItemsTotalByOrder(orderIds: Id[]): Promise<ReportOrderItemsTotalRow[]>;
  /** Entregas de comandas fechadas no intervalo, com entregador resolvido — `from`/`to` já são bordas UTC do dia local. */
  listDeliveriesBetween(from: string, to: string): Promise<ReportDeliveryRow[]>;
}

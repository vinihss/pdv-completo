import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  integer,
  real,
  boolean,
  bigserial,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

// ============================================================
// Schema Postgres — banco OFICIAL do PDV (o SQLite foi removido).
//
// Este schema é o mesmo contrato de dados que o app já consome, para
// que a migração não exigisse reescrever serializadores, comparações
// de tempo nem o seed:
//
//   - PK            -> text. O id continua sendo gerado no app com
//                      crypto.randomUUID() ( igual ao SQLite ), o que
//                      também preserva os ids externos/não-UUID que já
//                      existem: 'system' (SYSTEM_USER_ID), 'singleton'
//                      (store_settings), ids do iFood (evt_/ord_), telefone
//                      (customer_cart/whatsapp_conversation) e o cardápio
//                      Unami (cat-unami-*, p-unami-NNN).
//   - TIMESTAMPTZ   -> text ISO-8601 UTC. O app compara/deduplica com
//                      new Date().toISOString(); em text o ORDEM é
//                      lexicográfico = cronológico, desde que o formato
//                      seja uniforme — por isso o DEFAULT do banco gera
//                      exatamente o mesmo formato do toISOString().
//   - JSONB         -> text serializado. O app já faz JSON.parse/stringify
//                      na borda (ver domain/variations.ts), então o
//                      formato em disco não muda.
//   - money/qty     -> real (double precision). Devolve number no JS.
//                      NUMERIC voltaria string no node-postgres e
//                      quebraria a aritmética de round2/moneyEq.
//
// Onde o Postgres é nativo de verdade ( invisível pro app ): enums
// tipados, boolean, índices, chaves estrangeiras com ON DELETE e CHECKs.
// ============================================================

// to_char no formato EXATO de Date.prototype.toISOString() — 3 dígitos de
// milissegundo e 'Z' literal. Mantém a ordenação lexicográfica correta.
const isoNow = sql`to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ---------- enums ----------
export const userRole = pgEnum("user_role", ["waiter", "kitchen", "manager", "courier", "system", "cashier"]);
export const tableStatus = pgEnum("table_status", ["free", "occupied", "closing"]);
export const orderStatus = pgEnum("order_status", ["open", "closed", "cancelled"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "card", "pix", "other"]);
export const orderChannel = pgEnum("channel", ["balcao", "whatsapp", "web", "ifood"]);
export const orderItemStatus = pgEnum("order_item_status", ["ordered", "ready", "delivered", "cancelled"]);
export const stockMovementType = pgEnum("stock_movement_type", ["sale", "refund", "purchase", "adjustment"]);
export const cashDrawerStatus = pgEnum("cash_drawer_status", ["open", "closed"]);
export const cashMovementType = pgEnum("cash_movement_type", ["sangria", "suprimento"]);
export const ifoodEventStatus = pgEnum("ifood_event_status", ["received", "processed", "ignored", "failed", "acked"]);
export const whatsappState = pgEnum("whatsapp_state", ["welcome", "browsing", "cart", "checkout", "done", "awaiting_location", "awaiting_confirmation", "awaiting_correction"]);
export const deliveryStatus = pgEnum("delivery_status", ["awaiting_courier", "out_for_delivery", "delivered", "failed", "cancelled"]);
export const pixKeyType = pgEnum("pix_key_type", ["cpf", "cnpj", "email", "phone", "random"]);
export const idempotencyStatus = pgEnum("idempotency_status", ["processing", "completed", "failed"]);
export const whatsappConnectionStatus = pgEnum("whatsapp_connection_status", ["active", "expired", "revoked", "disconnected"]);
export const whatsappMessageStatus = pgEnum("whatsapp_message_status", ["sent", "delivered", "read", "failed"]);
export const whatsappMessageKind = pgEnum("whatsapp_message_kind", ["notification", "bot_reply"]);

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

// ---------- pessoas ----------
export const users = pgTable("user", {
  id: id(),
  name: text("name").notNull(),
  role: userRole("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: text("locked_until"),
  active: boolean("active").notNull().default(true),
  phone: text("phone"),
  email: text("email"),
  photoPath: text("photo_path"),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

export const customers = pgTable(
  "customer",
  {
    id: id(),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    // Perfil completo (0008). Os três guardam o valor CRU, sem máscara — a
    // apresentação é do frontend, o banco é a fonte: `photo_path` só o
    // basename (`<id>.<ext>`), `cpf` os 11 dígitos, `notes` o texto livre.
    photoPath: text("photo_path"),
    cpf: text("cpf"),
    notes: text("notes"),
    // Soft-delete: cliente tem histórico de pedidos (order.customer_id), então
    // a manutenção desativa em vez de apagar — reativável a qualquer momento.
    active: boolean("active").notNull().default(true),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("idx_customer_name").on(t.name),
    index("idx_customer_phone").on(t.phone),
    uniqueIndex("uq_customer_email").on(t.email).where(sql`${t.email} IS NOT NULL`),
    // CPF único quando informado — mesmo formato parcial do email. O
    // "quando informado" é o que mantém válido o cliente sem documento.
    uniqueIndex("uq_customer_cpf").on(t.cpf).where(sql`${t.cpf} IS NOT NULL`),
  ],
);

export const restaurantTables = pgTable("restaurant_table", {
  id: id(),
  number: text("number").notNull().unique(),
  status: tableStatus("status").notNull().default("free"),
  createdAt: text("created_at").notNull().default(isoNow),
});

// ---------- catálogo ----------
export const categories = pgTable("category", {
  id: id(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at").notNull().default(isoNow),
});

export const kitchenGroups = pgTable("kitchen_group", {
  id: id(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at").notNull().default(isoNow),
});

export const products = pgTable(
  "product",
  {
    id: id(),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    kitchenGroupId: text("kitchen_group_id").references(() => kitchenGroups.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    price: real("price").notNull(),
    variations: text("variations").notNull().default("[]"), // JSON string
    imagePath: text("image_path"), // caminho servido via /uploads/<id>.<ext>
    ifoodEnabled: boolean("ifood_enabled").notNull().default(false),
    ifoodSku: text("ifood_sku"),
    // Vitrine da página pública (/pedido) — migration 0020. Curadoria pura:
    // o produto continua na sua categoria.
    featured: boolean("featured").notNull().default(false),
    // Estoque (0016): config do produto — o saldo em si fica no ledger
    // stock_movement (soma dos deltas), nunca coluna cacheada.
    costPrice: real("cost_price").notNull().default(0), // custo unitário (margem)
    lowStockThreshold: real("low_stock_threshold").notNull().default(0),
    trackStock: boolean("track_stock").notNull().default(false),
    unit: text("unit").notNull().default("un"), // unidade de medida (0017)
    active: boolean("active").notNull().default(true),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    index("idx_product_category").on(t.categoryId),
    index("idx_product_kitchen_group").on(t.kitchenGroupId),
    check("chk_product_price", sql`${t.price} >= 0`),
  ],
);

// ---------- comandas ----------
export const orders = pgTable(
  "order",
  {
    id: id(),
    tableId: text("table_id").references(() => restaurantTables.id, { onDelete: "restrict" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    tabLabel: text("tab_label"),
    waiterId: text("waiter_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: orderStatus("status").notNull().default("open"),
    openedAt: text("opened_at").notNull().default(isoNow),
    closedAt: text("closed_at"),
    paymentMethod: paymentMethod("payment_method"),
    paymentConfirmedAt: text("payment_confirmed_at"),
    paymentConfirmedBy: text("payment_confirmed_by").references(() => users.id),
    channel: orderChannel("channel").notNull().default("balcao"),
    externalRef: text("external_ref"), // order id externo: iFood quando channel === "ifood"
    deliveryFee: real("delivery_fee"), // snapshot da taxa cobrada, só para channel != "balcao"
    cancelReason: text("cancel_reason"),
    notes: text("notes"),
    ifoodPayments: text("ifood_payments"), // métodos de pagamento do iFood (JSON)
  },
  (t) => [
    index("idx_order_table").on(t.tableId),
    index("idx_order_customer").on(t.customerId),
    index("idx_order_status").on(t.status),
    index("idx_order_waiter").on(t.waiterId),
    // iFood entrega o mesmo pedido mais de uma vez se o polling reencontrar
    // o evento; o índice único deixa o conflito explícito em vez de abrir
    // duas comandas.
    uniqueIndex("uq_order_channel_external_ref").on(t.channel, t.externalRef),
    check(
      "chk_order_identification_required",
      sql`${t.tableId} is not null or ${t.customerId} is not null or ${t.tabLabel} is not null`,
    ),
  ],
);

export const orderPayments = pgTable(
  "order_payment",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    method: paymentMethod("method").notNull(),
    amount: real("amount").notNull(),
    received: real("received"), // só cash: quanto o cliente entregou
    change: real("change"), // só cash: received - amount (troco)
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedAt: text("confirmed_at"),
    confirmedBy: text("confirmed_by").references(() => users.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_order_payment_order").on(t.orderId), check("chk_order_payment_amount", sql`${t.amount} > 0`)],
);

export const orderItems = pgTable(
  "order_item",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPrice: real("unit_price").notNull(), // snapshot de products.price
    costPrice: real("cost_price").notNull().default(0), // snapshot do custo no lançamento (margem)
    selectedVariations: text("selected_variations").notNull().default("{}"), // JSON string
    notes: text("notes"),
    status: orderItemStatus("status").notNull().default("ordered"),
    version: integer("version").notNull().default(1), // optimistic locking
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [index("idx_order_item_order").on(t.orderId), index("idx_order_item_product").on(t.productId)],
);

// ---------- compras / estoque ----------
export const suppliers = pgTable("supplier", {
  id: id(),
  name: text("name").notNull(),
  phone: text("phone"),
  taxId: text("tax_id"),
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

// Documento de entrada de mercadoria (0017) — multi-item, com fornecedor,
// nº de nota (informativo, sem integração fiscal), data e total.
export const purchases = pgTable("purchase", {
  id: id(),
  supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number"),
  issuedOn: text("issued_on"),
  note: text("note"),
  total: real("total").notNull().default(0),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: text("created_at").notNull().default(isoNow),
});

// Linha da compra — cada linha vira um movimento `purchase` no ledger com
// unit_cost (evento de valoração da média móvel). batch_no/expiry_date são
// informativos (rastreio; baixa sem FIFO — ver docs/08).
export const purchaseItems = pgTable(
  "purchase_item",
  {
    id: id(),
    // Ordem de inserção da linha no documento. O `rowid` do SQLite dava isso
    // de graça; no Postgres a sequência é explícita — sem ela, duas linhas do
    // MESMO produto (mesmo `orderBy(products.name)`) voltariam em ordem
    // arbitrária e o gerente veria o lançamento embaralhado.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: real("quantity").notNull(),
    unitCost: real("unit_cost").notNull(),
    lineTotal: real("line_total").notNull().default(0),
    batchNo: text("batch_no"),
    expiryDate: text("expiry_date"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_purchase_item_purchase").on(t.purchaseId)],
);

// Ledger de estoque (0016): fonte da verdade do saldo — soma dos deltas por
// produto. 'sale' no lançamento da comanda, 'refund' no estorno (item
// removido / comanda cancelada), 'purchase'/'adjustment' manuais do gerente.
//
// `seq` (bigserial) é a ordem de inserção: a média móvel é um REPLAY do
// ledger, então a ordem precisa ser estável e determinística. No SQLite isso
// era o `rowid` implícito; no Postgres não existe rowid, então a sequência
// explícita cumpre o papel (ver computeMovingAverageTx).
export const stockMovements = pgTable(
  "stock_movement",
  {
    id: id(),
    // mode "number" devolve number (e não bigint) pro app — o replay da
    // média móvel compara/ordena seq em JS e não quer BigInt.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    type: stockMovementType("type").notNull(),
    quantityDelta: real("quantity_delta").notNull(),
    // 0017: custo unitário nos eventos de valoração (purchase / estoque inicial)
    unitCost: real("unit_cost"),
    purchaseItemId: text("purchase_item_id").references(() => purchaseItems.id, { onDelete: "set null" }),
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
    orderItemId: text("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
    note: text("note"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("idx_stock_movement_product").on(t.productId),
    index("idx_stock_movement_order").on(t.orderId),
    index("idx_stock_movement_order_item").on(t.orderItemId),
    index("idx_stock_movement_product_seq").on(t.productId, t.seq),
  ],
);

// ---------- alertas (sino do app) ----------
// Central de alertas: o que chega (abertura de comanda) com o estado de
// "não visualizado" persistido no servidor. Sem isso o contador do sino morreria
// num F5 — e um tablet deitado na mesa é o caso normal, não a exceção.
//
// `read_at` é global, não por usuário: o alerta pergunta "alguém já viu isso?",
// e quem responde é a tela da comanda (POST /alerts/mark-read, chamado por
// OrderDetailScreen). `audienceRoles` filtra a recepção: NULL/vazio = todos os
// papéis; preenchido = só os listados (o recorte do realtime são os rooms
// `alerts` e `alerts:<role>` — ver application/alert/alert.usecases.ts).
export const alerts = pgTable(
  "alert",
  {
    id: id(),
    // Ordem de inserção: `created_at` é texto com precisão de milissegundo, e
    // dois alertas no mesmo ms empatariam num ORDER BY só por ele (mesma razão
    // do `seq` de outbox_event).
    seq: bigserial("seq", { mode: "number" }).notNull(),
    kind: text("kind").notNull().default("order_created"),
    title: text("title").notNull(),
    body: text("body"),
    orderId: text("order_id").references(() => orders.id, { onDelete: "cascade" }),
    channel: text("channel"),
    audienceRoles: text("audience_roles").array(),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("idx_alert_created_at").on(t.createdAt, t.seq),
    index("idx_alert_unread").on(t.createdAt).where(sql`${t.readAt} IS NULL`),
    index("idx_alert_order").on(t.orderId),
  ],
);

// ---------- fluxo de caixa ----------
// Uma sessão aberta por vez: o índice único parcial garante no banco o que
// antes era só regra de usecase (ver findOpenDrawerTx).
export const cashDrawers = pgTable(
  "cash_drawer",
  {
    id: id(),
    status: cashDrawerStatus("status").notNull().default("open"),
    openedAt: text("opened_at").notNull().default(isoNow),
    openedBy: text("opened_by")
      .notNull()
      .references(() => users.id),
    openingAmount: real("opening_amount").notNull().default(0),
    closedAt: text("closed_at"),
    closedBy: text("closed_by").references(() => users.id),
    closingExpected: real("closing_expected"),
    closingCounted: real("closing_counted"),
    closingDifference: real("closing_difference"),
    closingNote: text("closing_note"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    uniqueIndex("uq_cash_drawer_single_open").on(t.status).where(sql`${t.status} = 'open'`),
    index("idx_cash_drawer_opened_at").on(t.openedAt),
  ],
);

export const cashDrawerMovements = pgTable(
  "cash_drawer_movement",
  {
    id: id(),
    drawerId: text("drawer_id")
      .notNull()
      .references(() => cashDrawers.id, { onDelete: "cascade" }),
    type: cashMovementType("type").notNull(),
    amount: real("amount").notNull(),
    note: text("note"),
    refOrderId: text("ref_order_id").references(() => orders.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_cash_drawer_movement_drawer").on(t.drawerId)],
);

// ---------- configuração (singleton) ----------
export const storeSettings = pgTable("store_settings", {
  id: text("id").primaryKey().default("singleton"),
  merchantName: text("merchant_name").notNull(),
  merchantCity: text("merchant_city").notNull(),
  logoPath: text("logo_path"), // nome do arquivo do logo em /uploads/logo.<ext>
  brandColor: text("brand_color").notNull().default("#f59e0b"),
  pixKey: text("pix_key").notNull().default(""),
  pixKeyType: pixKeyType("pix_key_type").notNull().default("phone"),
  usesTables: boolean("uses_tables").notNull().default(true),
  kitchenEnabled: boolean("kitchen_enabled").notNull().default(true),
  usesDelivery: boolean("uses_delivery").notNull().default(true),
  ifoodIntegrationEnabled: boolean("ifood_integration_enabled").notNull().default(false),
  // Integração WhatsApp (0007): master switch do painel em Configurações.
  whatsappIntegrationEnabled: boolean("whatsapp_integration_enabled").notNull().default(false),
  inventoryEnabled: boolean("inventory_enabled").notNull().default(false), // estoque (0016)
  purchaseEnabled: boolean("purchase_enabled").notNull().default(false), // compras + custo médio (0017)
  // Impressão térmica (daemon local, 0003): master switch + auto-print.
  printerEnabled: boolean("printer_enabled").notNull().default(false),
  printerAutoPrint: boolean("printer_auto_print").notNull().default(false),
  enabledPaymentMethods: text("enabled_payment_methods").notNull().default('["cash","card","pix","other"]'),
  kitchenPrepWarnMin: integer("kitchen_prep_warn_min").notNull().default(3),
  kitchenPrepUrgentMin: integer("kitchen_prep_urgent_min").notNull().default(6),
  kitchenPickupUrgentMin: integer("kitchen_pickup_urgent_min").notNull().default(5),
  deliveryFee: real("delivery_fee").notNull().default(0),
  restaurantLat: real("restaurant_lat"),
  restaurantLong: real("restaurant_long"),
  freeDeliveryMin: real("free_delivery_min").notNull().default(0),
  deliveryFeeTiers: text("delivery_fee_tiers").notNull().default("[]"),
  deliveryPrepMinutes: integer("delivery_prep_minutes").notNull().default(40),
  minutesPerKm: integer("minutes_per_km").notNull().default(2),
});

// ---------- infraestrutura ----------
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    orderId: text("order_id").references(() => orders.id),
    details: text("details").notNull().default("{}"), // JSON string
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_audit_log_user").on(t.userId), index("idx_audit_log_order").on(t.orderId), index("idx_audit_log_created").on(t.createdAt)],
);

export const idempotencyKeys = pgTable(
  "idempotency_key",
  {
    correlationId: text("correlation_id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    responseBody: text("response_body"),
    responseStatus: integer("response_status"),
    status: idempotencyStatus("status").notNull().default("processing"),
    createdAt: text("created_at").notNull().default(isoNow),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("idx_idempotency_key_expires").on(t.expiresAt)],
);

export const outboxEvents = pgTable(
  "outbox_event",
  {
    id: id(),
    // `seq` (bigserial) é a ordem de inserção. Sem isso, dois eventos com o
    // mesmo `created_at` (mesma milissegundo) teriam ordem indefinida — no
    // SQLite o `rowid` resolvia; aqui a sequência é a desambiguação.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(), // JSON string
    room: text("room").notNull(),
    published: boolean("published").notNull().default(false),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  // O dispatcher faz poll em "não publicado, mais antigo primeiro" — o índice
  // parcial mantém esse SELECT barato mesmo com o outbox cheio de publicados.
  (t) => [
    index("idx_outbox_event_unpublished").on(t.createdAt, t.seq).where(sql`${t.published} = false`),
  ],
);

// ---------- iFood ----------
// Log/dedupe dos eventos recebidos do polling do iFood: obrigatório persistir
// ANTES do ACK (senão o iFood aplica throttle). O status vira o bookkeeping:
// received → processed/ignored/failed → acked.
export const ifoodEvents = pgTable(
  "ifood_event",
  {
    id: text("id").primaryKey(), // event id do iFood (evt_...)
    orderRef: text("order_ref"), // order id do iFood (ord_...)
    code: text("code").notNull(),
    fullCode: text("full_code"),
    status: ifoodEventStatus("status").notNull().default("received"),
    raw: text("raw").notNull().default("{}"), // payload completo do evento
    processedAt: text("processed_at"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_ifood_event_status").on(t.status)],
);

// KV singleton para estado da integração: accessToken + expiração, merchantId
// resolvido, timestamps de último poll/sync.
export const ifoodState = pgTable("ifood_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

// ---------- self-service / delivery ----------
export const customerAddresses = pgTable(
  "customer_address",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    label: text("label"),
    // CEP é opcional e nullable: entrou depois (0005) e os endereços já
    // gravados não têm o dado. Guardado com os 8 dígitos crus, sem máscara.
    cep: text("cep"),
    street: text("street").notNull(),
    number: text("number").notNull(),
    complement: text("complement"),
    neighborhood: text("neighborhood").notNull(),
    city: text("city").notNull(),
    state: text("state"),
    reference: text("reference"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_customer_address_customer").on(t.customerId)],
);

export const whatsappConversations = pgTable("whatsapp_conversation", {
  phone: text("phone").primaryKey(),
  state: whatsappState("state").notNull().default("welcome"),
  cartItems: text("cart_items").notNull().default("[]"), // JSON string
  customerName: text("customer_name"),
  deliveryAddress: text("delivery_address"),
  // Rastreabilidade (0002): a WABA de onde a conversa veio. Não é parte
  // do PK porque há UMA conexão ativa por instalação — enforced no banco
  // por uq_whatsapp_single_active. Nullable porque a coluna entrou depois.
  wabaId: text("waba_id"),
  updatedAt: text("updated_at").notNull().default(isoNow),
  expiresAt: text("expires_at").notNull(),
});

// 1:1 com orders. Eixo separado de order_item.status, que já significa
// "servido na mesa" — não reaproveitado aqui para evitar ambiguidade.
export const deliveries = pgTable(
  "delivery",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: "cascade" }),
    courierId: text("courier_id").references(() => users.id, { onDelete: "set null" }),
    address: text("address").notNull(), // snapshot formatado, copiado do checkout
    distanceKm: real("distance_km"),
    estimatedMinutes: integer("estimated_minutes"),
    // 0018: "cancelled" é o cancelamento (manager ou cliente) — distinto de
    // "failed" ("problema na entrega").
    status: deliveryStatus("status").notNull().default("awaiting_courier"),
    dispatchedAt: text("dispatched_at"),
    deliveredAt: text("delivered_at"),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_delivery_status").on(t.status), index("idx_delivery_courier").on(t.courierId)],
);

// Carrinho server-side do cliente (0019) — continuação do pedido sem
// localStorage, chaveado pelo telefone.
export const customerCarts = pgTable(
  "customer_cart",
  {
    phone: text("phone").primaryKey(),
    items: text("items").notNull().default("[]"), // JSON string
    updatedAt: text("updated_at").notNull().default(isoNow),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("idx_customer_cart_expires").on(t.expiresAt)],
);

export const geocodingCache = pgTable(
  "geocoding_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    response: text("response").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("idx_geocoding_cache_expires").on(t.expiresAt)],
);

// ============================================================
// Embedded Signup / WhatsApp Cloud API (0002) — ver
// docs/10-whatsapp-embedded-signup.md
// ============================================================

// A WABA que o dono da loja conectou pelo Embedded Signup, com o token
// que o servidor trocou pelo código de autorização. Chave natural é
// waba_id: reconectar o mesmo WABA atualiza a linha em vez de duplicar.
// A unicidade de UMA conexão `active` é do BANCO
// (uq_whatsapp_single_active, índice parcial em status) — por isso o
// saveConnection desativa a anterior antes de promover a nova.
export const whatsappConnections = pgTable("whatsapp_connection", {
  id: id(),
  wabaId: text("waba_id").notNull().unique(),
  phoneNumberId: text("phone_number_id").notNull(),
  businessId: text("business_id"),
  businessName: text("business_name"),
  displayPhoneNumber: text("display_phone_number"),
  displayName: text("display_name"),
  accessToken: text("access_token").notNull(), // texto puro — mesmo tratamento do token do iFood (ifood_state)
  tokenExpiresAt: text("token_expires_at"), // null = token BISU sem expiração
  status: whatsappConnectionStatus("status").notNull().default("active"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

// Uma linha por mensagem ENVIADA, chaveada pelo wamid que a Meta devolve.
// É a junta entre o POST /messages e o webhook `messages.statuses`:
// sem esta linha não dá para dizer a qual pedido a mensagem entregue
// pertence. orderId é nullable porque o bot de auto-atendimento também
// envia, e essa mensagem não pertence a nenhum pedido.
export const whatsappOutboundMessages = pgTable(
  "whatsapp_outbound_message",
  {
    id: text("id").primaryKey(), // wamid (wamid.XXXX...)
    wabaId: text("waba_id")
      .notNull()
      .references(() => whatsappConnections.wabaId, { onDelete: "cascade" }),
    orderId: text("order_id").references(() => orders.id, { onDelete: "cascade" }),
    toPhone: text("to_phone").notNull(),
    kind: whatsappMessageKind("kind").notNull(),
    status: whatsappMessageStatus("status").notNull().default("sent"),
    errorCode: integer("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    index("idx_whatsapp_outbound_order").on(t.orderId),
    index("idx_whatsapp_outbound_waba_created").on(t.wabaId, t.createdAt),
  ],
);

// Dedupe do inbound: a Meta reenvia o MESMO webhook enquanto não receber
// 200, por até ~7 dias. `type` é TEXT de propósito (não enum) — a Meta
// adiciona tipos sem aviso e um enum quebraria no primeiro novo.
export const whatsappInboundMessages = pgTable(
  "whatsapp_inbound_message",
  {
    id: text("id").primaryKey(), // wamid (wamid.XXXX...)
    wabaId: text("waba_id")
      .notNull()
      .references(() => whatsappConnections.wabaId, { onDelete: "cascade" }),
    fromPhone: text("from_phone").notNull(),
    type: text("type").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_whatsapp_inbound_waba").on(t.wabaId)],
);

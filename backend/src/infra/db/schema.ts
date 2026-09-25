import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ============================================================
// Schema SQLite — espelha o schema Postgres de 01-backend-spec.md §4.
// SQLite não tem tipos ENUM/UUID/JSONB/TIMESTAMPTZ nativos, então:
//   - UUID          -> text (gerado em app com crypto.randomUUID())
//   - ENUM          -> text com CHECK constraint
//   - JSONB         -> text (serializado/desserializado na camada de repositório)
//   - TIMESTAMPTZ   -> text (ISO 8601 UTC)
//   - BOOLEAN       -> integer (0/1), mode "boolean" do Drizzle
// Isso é só a representação física — o restante do código nunca lida
// com esses detalhes, sempre com valores JS nativos (Drizzle converte).
// ============================================================

export const users = sqliteTable("user", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  role: text("role", { enum: ["waiter", "kitchen", "manager", "courier", "system", "cashier"] }).notNull(),
  pinHash: text("pin_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: text("locked_until"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
});

export const categories = sqliteTable("category", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const kitchenGroups = sqliteTable("kitchen_group", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const products = sqliteTable("product", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
  kitchenGroupId: text("kitchen_group_id").references(() => kitchenGroups.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: real("price").notNull(),
  variations: text("variations").notNull().default("[]"), // JSON string
  imagePath: text("image_path"), // caminho servido via /uploads/<id>.<ext>
  ifoodEnabled: integer("ifood_enabled", { mode: "boolean" }).notNull().default(false),
  ifoodSku: text("ifood_sku"),
  // Estoque (migration 0016): config do produto — o saldo em si fica no
  // ledger stock_movement (soma dos deltas), nunca coluna cacheada.
  costPrice: real("cost_price").notNull().default(0), // custo unitário (margem)
  lowStockThreshold: real("low_stock_threshold").notNull().default(0),
  trackStock: integer("track_stock", { mode: "boolean" }).notNull().default(false),
  unit: text("unit").notNull().default("un"), // unidade de medida (0017)
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
});

export const restaurantTables = sqliteTable("restaurant_table", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  number: text("number").notNull().unique(),
  status: text("status", { enum: ["free", "occupied", "closing"] }).notNull().default("free"),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const customers = sqliteTable("customer", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  phone: text("phone"),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const orders = sqliteTable("order", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tableId: text("table_id").references(() => restaurantTables.id, { onDelete: "restrict" }),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  tabLabel: text("tab_label"),
  waiterId: text("waiter_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["open", "closed", "cancelled"] }).notNull().default("open"),
  openedAt: text("opened_at").notNull().default(sql`(current_timestamp)`),
  closedAt: text("closed_at"),
  paymentMethod: text("payment_method", { enum: ["cash", "card", "pix", "other"] }),
  paymentConfirmedAt: text("payment_confirmed_at"),
  paymentConfirmedBy: text("payment_confirmed_by").references(() => users.id),
  channel: text("channel", { enum: ["balcao", "whatsapp", "web", "ifood"] }).notNull().default("balcao"),
  externalRef: text("external_ref"), // order id externo: iFood quando channel === "ifood"
  deliveryFee: real("delivery_fee"), // snapshot da taxa cobrada, só para channel != "balcao"
  cancelReason: text("cancel_reason"),
  ifoodPayments: text("ifood_payments"), // métodos de pagamento do iFood (JSON), para fechar no CONCLUDED
});

export const orderPayments = sqliteTable("order_payment", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  method: text("method", { enum: ["cash", "card", "pix", "other"] }).notNull(),
  amount: real("amount").notNull(),
  received: real("received"), // só cash: quanto o cliente entregou
  change: real("change"), // só cash: received - amount (troco)
  confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
  confirmedAt: text("confirmed_at"),
  confirmedBy: text("confirmed_by").references(() => users.id),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const orderItems = sqliteTable("order_item", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  costPrice: real("cost_price").notNull().default(0), // snapshot do custo no lançamento (margem)
  selectedVariations: text("selected_variations").notNull().default("{}"), // JSON string
  notes: text("notes"),
  status: text("status", { enum: ["ordered", "ready", "delivered", "cancelled"] }).notNull().default("ordered"),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
});

// Fornecedores (0017) — vazio por padrão, usado quando `store_settings.purchase_enabled` liga.
export const suppliers = sqliteTable("supplier", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  phone: text("phone"),
  taxId: text("tax_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
});

// Documento de entrada de mercadoria (0017) — multi-item, com fornecedor,
// nº de nota (informativo, sem integração fiscal), data e total.
export const purchases = sqliteTable("purchase", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number"),
  issuedOn: text("issued_on"),
  note: text("note"),
  total: real("total").notNull().default(0),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// Linha da compra — cada linha vira um movimento `purchase` no ledger com
// unit_cost (evento de valoração da média móvel). batch_no/expiry_date são
// informativos (rastreio; baixa sem FIFO — ver docs/08).
export const purchaseItems = sqliteTable("purchase_item", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  purchaseId: text("purchase_id").notNull().references(() => purchases.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  quantity: real("quantity").notNull(),
  unitCost: real("unit_cost").notNull(),
  lineTotal: real("line_total").notNull().default(0),
  batchNo: text("batch_no"),
  expiryDate: text("expiry_date"),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// Ledger de estoque (migration 0016): fonte da verdade do saldo — soma dos
// deltas por produto. 'sale' no lançamento da comanda, 'refund' no estorno
// (item removido / comanda cancelada), 'purchase'/'adjustment' manuais do
// gerente. Desenhado para evoluir a ficha técnica: deltas genéricos.
export const stockMovements = sqliteTable("stock_movement", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["sale", "refund", "purchase", "adjustment"] }).notNull(),
  quantityDelta: real("quantity_delta").notNull(),
  // 0017: custo unitário nos eventos de valoração (purchase / estoque inicial)
  // — a média móvel é replay desses eventos, não coluna de estado.
  unitCost: real("unit_cost"),
  purchaseItemId: text("purchase_item_id").references(() => purchaseItems.id, { onDelete: "set null" }),
  orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
  orderItemId: text("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
  note: text("note"),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// Fluxo de caixa (migration 0012): uma sessão aberta por vez (índice parcial
// único). O "esperado" em dinheiro de cada sessão é calculado em usecase a
// partir de order_payment (method='cash', confirmed, confirmed_at no período)
// somado ao fundo inicial e movimentos manuais (sangria/suprimento).
export const cashDrawers = sqliteTable("cash_drawer", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  openedAt: text("opened_at").notNull().default(sql`(current_timestamp)`),
  openedBy: text("opened_by").notNull().references(() => users.id),
  openingAmount: real("opening_amount").notNull().default(0),
  closedAt: text("closed_at"),
  closedBy: text("closed_by").references(() => users.id),
  closingExpected: real("closing_expected"),
  closingCounted: real("closing_counted"),
  closingDifference: real("closing_difference"),
  closingNote: text("closing_note"),
  note: text("note"),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const cashDrawerMovements = sqliteTable("cash_drawer_movement", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  drawerId: text("drawer_id").notNull().references(() => cashDrawers.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["sangria", "suprimento"] }).notNull(),
  amount: real("amount").notNull(),
  note: text("note"),
  refOrderId: text("ref_order_id").references(() => orders.id),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// Singleton (linha única) — id fixo "singleton" pra facilitar SELECT/UPDATE sem WHERE dinâmico
export const storeSettings = sqliteTable("store_settings", {
  id: text("id").primaryKey().default("singleton"),
  merchantName: text("merchant_name").notNull(),
  merchantCity: text("merchant_city").notNull(),
  logoPath: text("logo_path"), // nome do arquivo do logo em /uploads/logo.<ext>
  brandColor: text("brand_color").notNull().default("#f59e0b"), // #hex da cor principal da marca
  pixKey: text("pix_key").notNull().default(""),
  pixKeyType: text("pix_key_type", { enum: ["cpf", "cnpj", "email", "phone", "random"] }).notNull().default("phone"),
  usesTables: integer("uses_tables", { mode: "boolean" }).notNull().default(true),
  kitchenEnabled: integer("kitchen_enabled", { mode: "boolean" }).notNull().default(true),
  usesDelivery: integer("uses_delivery", { mode: "boolean" }).notNull().default(true),
  ifoodIntegrationEnabled: integer("ifood_integration_enabled", { mode: "boolean" }).notNull().default(false),
  inventoryEnabled: integer("inventory_enabled", { mode: "boolean" }).notNull().default(false), // controle de estoque (0016)
  purchaseEnabled: integer("purchase_enabled", { mode: "boolean" }).notNull().default(false), // compras + custo médio (0017)
  enabledPaymentMethods: text("enabled_payment_methods").notNull().default('["cash","card","pix","other"]'),
  kitchenPrepWarnMin: integer("kitchen_prep_warn_min").notNull().default(3),
  kitchenPrepUrgentMin: integer("kitchen_prep_urgent_min").notNull().default(6),
  kitchenPickupUrgentMin: integer("kitchen_pickup_urgent_min").notNull().default(5),
  deliveryFee: real("delivery_fee").notNull().default(0),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  orderId: text("order_id").references(() => orders.id),
  details: text("details").notNull().default("{}"), // JSON string
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const idempotencyKeys = sqliteTable("idempotency_key", {
  correlationId: text("correlation_id").primaryKey(),
  endpoint: text("endpoint").notNull(),
  requestHash: text("request_hash").notNull(),
  responseBody: text("response_body"),
  responseStatus: integer("response_status"),
  status: text("status", { enum: ["processing", "completed", "failed"] }).notNull().default("processing"),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  expiresAt: text("expires_at").notNull(),
});

export const outboxEvents = sqliteTable("outbox_event", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(), // JSON string
  room: text("room").notNull(),
  published: integer("published", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// ============================================================
// Integração iFood (Order/Catalog API) — ver docs/06-ifood-integration.md
// ============================================================

// Log/dedupe dos eventos recebidos do polling do iFood: obrigatório persistir
// ANTES de ACK (senão o iFood aplica throttle). O status vira o bookkeeping:
// received → processed/ignored/failed → acked.
export const ifoodEvents = sqliteTable("ifood_event", {
  id: text("id").primaryKey(), // event id do iFood (evt_...)
  orderRef: text("order_ref"), // order id do iFood (ord_...)
  code: text("code").notNull(),
  fullCode: text("full_code"),
  status: text("status", { enum: ["received", "processed", "ignored", "failed", "acked"] }).notNull().default("received"),
  raw: text("raw").notNull().default("{}"), // payload completo do evento
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// KV singleton para estado da integração: accessToken + expiração, merchantId
// resolvido, timestamps de último poll/sync (auditoria no painel do gerente).
export const ifoodState = sqliteTable("ifood_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
});

// ============================================================
// Delivery self-service (WhatsApp + página externa) — §04/05 docs
// ============================================================

// Máximo 3 por cliente e apenas 1 is_default por vez: regras de
// usecase, não constraint de banco (ver 04-delivery-self-service-integration.md).
export const customerAddresses = sqliteTable("customer_address", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  label: text("label"),
  street: text("street").notNull(),
  number: text("number").notNull(),
  complement: text("complement"),
  neighborhood: text("neighborhood").notNull(),
  city: text("city").notNull(),
  reference: text("reference"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// Estado da máquina de conversa do bot — cada mensagem chega isolada via
// webhook, então o carrinho em construção vive aqui até a confirmação final.
export const whatsappConversations = sqliteTable("whatsapp_conversation", {
  phone: text("phone").primaryKey(),
  state: text("state", { enum: ["welcome", "browsing", "cart", "checkout", "done"] }).notNull().default("welcome"),
  cartItems: text("cart_items").notNull().default("[]"), // JSON string
  customerName: text("customer_name"),
  deliveryAddress: text("delivery_address"),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
  expiresAt: text("expires_at").notNull(),
});

// 1:1 com orders. Eixo separado de order_item.status, que já significa
// "servido na mesa" — não reaproveitado aqui para evitar ambiguidade.
export const deliveries = sqliteTable("delivery", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: text("order_id").notNull().unique().references(() => orders.id, { onDelete: "cascade" }),
  courierId: text("courier_id").references(() => users.id, { onDelete: "set null" }),
  address: text("address").notNull(), // snapshot formatado, copiado do checkout
  status: text("status", { enum: ["awaiting_courier", "out_for_delivery", "delivered", "failed"] })
    .notNull()
    .default("awaiting_courier"),
  dispatchedAt: text("dispatched_at"),
  deliveredAt: text("delivered_at"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

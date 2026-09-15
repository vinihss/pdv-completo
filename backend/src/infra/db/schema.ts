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
  role: text("role", { enum: ["waiter", "kitchen", "manager", "courier", "system"] }).notNull(),
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

export const products = sqliteTable("product", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: real("price").notNull(),
  variations: text("variations").notNull().default("[]"), // JSON string
  imagePath: text("image_path"), // caminho servido via /uploads/<id>.<ext>
  ifoodEnabled: integer("ifood_enabled", { mode: "boolean" }).notNull().default(false),
  ifoodSku: text("ifood_sku"),
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
  channel: text("channel", { enum: ["balcao", "whatsapp", "web"] }).notNull().default("balcao"),
  externalRef: text("external_ref"), // reservado para integração futura com iFood
  deliveryFee: real("delivery_fee"), // snapshot da taxa cobrada, só para channel != "balcao"
  cancelReason: text("cancel_reason"),
});

export const orderItems = sqliteTable("order_item", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  selectedVariations: text("selected_variations").notNull().default("{}"), // JSON string
  notes: text("notes"),
  status: text("status", { enum: ["ordered", "ready", "delivered", "cancelled"] }).notNull().default("ordered"),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
});

// Singleton (linha única) — id fixo "singleton" pra facilitar SELECT/UPDATE sem WHERE dinâmico
export const storeSettings = sqliteTable("store_settings", {
  id: text("id").primaryKey().default("singleton"),
  merchantName: text("merchant_name").notNull(),
  merchantCity: text("merchant_city").notNull(),
  pixKey: text("pix_key").notNull().default(""),
  pixKeyType: text("pix_key_type", { enum: ["cpf", "cnpj", "email", "phone", "random"] }).notNull().default("phone"),
  usesTables: integer("uses_tables", { mode: "boolean" }).notNull().default(true),
  kitchenEnabled: integer("kitchen_enabled", { mode: "boolean" }).notNull().default(true),
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

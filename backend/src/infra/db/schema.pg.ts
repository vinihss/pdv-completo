import { pgTable, text, integer, real, boolean, timestamp, jsonb, uuid, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================
// Schema Postgres — espelha o schema SQLite (schema.ts) para o modo cloud.
// Tipos nativos: UUID, TEXT, INTEGER, REAL, BOOLEAN, TIMESTAMPTZ, JSONB.
// ============================================================

export const userRoleEnum = pgEnum("user_role", ["waiter", "kitchen", "manager", "courier", "system", "cashier"]);
export const orderStatusEnum = pgEnum("order_status", ["open", "closed", "cancelled"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cash", "card", "pix", "other"]);
export const channelEnum = pgEnum("channel", ["balcao", "whatsapp", "web", "ifood"]);
export const itemStatusEnum = pgEnum("item_status", ["ordered", "ready", "delivered", "cancelled"]);
export const stockMovementTypeEnum = pgEnum("stock_movement_type", ["sale", "refund", "purchase", "adjustment"]);
export const cashDrawerStatusEnum = pgEnum("cash_drawer_status", ["open", "closed"]);
export const cashDrawerMovementTypeEnum = pgEnum("cash_drawer_movement_type", ["sangria", "suprimento"]);
export const ifoodEventStatusEnum = pgEnum("ifood_event_status", ["received", "processed", "ignored", "failed", "acked"]);
export const whatsappStateEnum = pgEnum("whatsapp_state", ["welcome", "browsing", "cart", "checkout", "done", "awaiting_location", "awaiting_confirmation", "awaiting_correction"]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["awaiting_courier", "out_for_delivery", "delivered", "failed", "cancelled"]);
export const tableStatusEnum = pgEnum("table_status", ["free", "occupied", "closing"]);
export const pixKeyTypeEnum = pgEnum("pix_key_type", ["cpf", "cnpj", "email", "phone", "random"]);
export const idempotencyStatusEnum = pgEnum("idempotency_status", ["processing", "completed", "failed"]);

export const users = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable("category", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kitchenGroups = pgTable("kitchen_group", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable("product", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  kitchenGroupId: uuid("kitchen_group_id").references(() => kitchenGroups.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: real("price").notNull(),
  variations: jsonb("variations").notNull().default([]),
  imagePath: text("image_path"),
  ifoodEnabled: boolean("ifood_enabled").notNull().default(false),
  ifoodSku: text("ifood_sku"),
  featured: boolean("featured").notNull().default(false),
  costPrice: real("cost_price").notNull().default(0),
  lowStockThreshold: real("low_stock_threshold").notNull().default(0),
  trackStock: boolean("track_stock").notNull().default(false),
  unit: text("unit").notNull().default("un"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const restaurantTables = pgTable("restaurant_table", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: text("number").notNull().unique(),
  status: tableStatusEnum("status").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable("customer", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("order", {
  id: uuid("id").primaryKey().defaultRandom(),
  tableId: uuid("table_id").references(() => restaurantTables.id, { onDelete: "restrict" }),
  customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
  tabLabel: text("tab_label"),
  waiterId: uuid("waiter_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  status: orderStatusEnum("status").notNull().default("open"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  paymentMethod: paymentMethodEnum("payment_method"),
  paymentConfirmedAt: timestamp("payment_confirmed_at", { withTimezone: true }),
  paymentConfirmedBy: uuid("payment_confirmed_by").references(() => users.id),
  channel: channelEnum("channel").notNull().default("balcao"),
  externalRef: text("external_ref"),
  deliveryFee: real("delivery_fee"),
  cancelReason: text("cancel_reason"),
  ifoodPayments: jsonb("ifood_payments"),
});

export const orderPayments = pgTable("order_payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  method: paymentMethodEnum("method").notNull(),
  amount: real("amount").notNull(),
  received: real("received"),
  change: real("change"),
  confirmed: boolean("confirmed").notNull().default(false),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: uuid("confirmed_by").references(() => users.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderItems = pgTable("order_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  costPrice: real("cost_price").notNull().default(0),
  selectedVariations: jsonb("selected_variations").notNull().default({}),
  notes: text("notes"),
  status: itemStatusEnum("status").notNull().default("ordered"),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suppliers = pgTable("supplier", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone"),
  taxId: text("tax_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchases = pgTable("purchase", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number"),
  issuedOn: text("issued_on"),
  note: text("note"),
  total: real("total").notNull().default(0),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseItems = pgTable("purchase_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchaseId: uuid("purchase_id").notNull().references(() => purchases.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  quantity: real("quantity").notNull(),
  unitCost: real("unit_cost").notNull(),
  lineTotal: real("line_total").notNull().default(0),
  batchNo: text("batch_no"),
  expiryDate: text("expiry_date"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stockMovements = pgTable("stock_movement", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  type: stockMovementTypeEnum("type").notNull(),
  quantityDelta: real("quantity_delta").notNull(),
  unitCost: real("unit_cost"),
  purchaseItemId: uuid("purchase_item_id").references(() => purchaseItems.id, { onDelete: "set null" }),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
  orderItemId: uuid("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
  note: text("note"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cashDrawers = pgTable("cash_drawer", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: cashDrawerStatusEnum("status").notNull().default("open"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  openedBy: uuid("opened_by").notNull().references(() => users.id),
  openingAmount: real("opening_amount").notNull().default(0),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: uuid("closed_by").references(() => users.id),
  closingExpected: real("closing_expected"),
  closingCounted: real("closing_counted"),
  closingDifference: real("closing_difference"),
  closingNote: text("closing_note"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cashDrawerMovements = pgTable("cash_drawer_movement", {
  id: uuid("id").primaryKey().defaultRandom(),
  drawerId: uuid("drawer_id").notNull().references(() => cashDrawers.id, { onDelete: "cascade" }),
  type: cashDrawerMovementTypeEnum("type").notNull(),
  amount: real("amount").notNull(),
  note: text("note"),
  refOrderId: uuid("ref_order_id").references(() => orders.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storeSettings = pgTable("store_settings", {
  id: text("id").primaryKey().default("singleton"),
  merchantName: text("merchant_name").notNull(),
  merchantCity: text("merchant_city").notNull(),
  logoPath: text("logo_path"),
  brandColor: text("brand_color").notNull().default("#f59e0b"),
  pixKey: text("pix_key").notNull().default(""),
  pixKeyType: pixKeyTypeEnum("pix_key_type").notNull().default("phone"),
  usesTables: boolean("uses_tables").notNull().default(true),
  kitchenEnabled: boolean("kitchen_enabled").notNull().default(true),
  usesDelivery: boolean("uses_delivery").notNull().default(true),
  ifoodIntegrationEnabled: boolean("ifood_integration_enabled").notNull().default(false),
  inventoryEnabled: boolean("inventory_enabled").notNull().default(false),
  purchaseEnabled: boolean("purchase_enabled").notNull().default(false),
  enabledPaymentMethods: jsonb("enabled_payment_methods").notNull().default(["cash", "card", "pix", "other"]),
  kitchenPrepWarnMin: integer("kitchen_prep_warn_min").notNull().default(3),
  kitchenPrepUrgentMin: integer("kitchen_prep_urgent_min").notNull().default(6),
  kitchenPickupUrgentMin: integer("kitchen_pickup_urgent_min").notNull().default(5),
  deliveryFee: real("delivery_fee").notNull().default(0),
  restaurantLat: real("restaurant_lat"),
  restaurantLong: real("restaurant_long"),
  freeDeliveryMin: real("free_delivery_min").notNull().default(0),
  deliveryFeeTiers: jsonb("delivery_fee_tiers").notNull().default([]),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  orderId: uuid("order_id").references(() => orders.id),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable("idempotency_key", {
  correlationId: text("correlation_id").primaryKey(),
  endpoint: text("endpoint").notNull(),
  requestHash: text("request_hash").notNull(),
  responseBody: text("response_body"),
  responseStatus: integer("response_status"),
  status: idempotencyStatusEnum("status").notNull().default("processing"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const outboxEvents = pgTable("outbox_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  room: text("room").notNull(),
  published: boolean("published").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ifoodEvents = pgTable("ifood_event", {
  id: text("id").primaryKey(),
  orderRef: text("order_ref"),
  code: text("code").notNull(),
  fullCode: text("full_code"),
  status: ifoodEventStatusEnum("status").notNull().default("received"),
  raw: jsonb("raw").notNull().default({}),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ifoodState = pgTable("ifood_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customerAddresses = pgTable("customer_address", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  label: text("label"),
  street: text("street").notNull(),
  number: text("number").notNull(),
  complement: text("complement"),
  neighborhood: text("neighborhood").notNull(),
  city: text("city").notNull(),
  reference: text("reference"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const whatsappConversations = pgTable("whatsapp_conversation", {
  phone: text("phone").primaryKey(),
  state: whatsappStateEnum("state").notNull().default("welcome"),
  cartItems: jsonb("cart_items").notNull().default([]),
  customerName: text("customer_name"),
  deliveryAddress: text("delivery_address"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const deliveries = pgTable("delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().unique().references(() => orders.id, { onDelete: "cascade" }),
  courierId: uuid("courier_id").references(() => users.id, { onDelete: "set null" }),
  address: text("address").notNull(),
  distanceKm: real("distance_km"),
  estimatedMinutes: integer("estimated_minutes"),
  status: deliveryStatusEnum("status").notNull().default("awaiting_courier"),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customerCarts = pgTable("customer_cart", {
  phone: text("phone").primaryKey(),
  items: jsonb("items").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const geocodingCache = pgTable("geocoding_cache", {
  cacheKey: text("cache_key").primaryKey(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

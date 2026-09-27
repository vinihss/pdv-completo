-- ============================================================
-- Migration Postgres inicial — cria todas as tabelas do schema
-- Equivalente às migrations SQLite 0001-0020 combinadas
-- ============================================================

-- Enums
CREATE TYPE user_role AS ENUM ('waiter', 'kitchen', 'manager', 'courier', 'system', 'cashier');
CREATE TYPE order_status AS ENUM ('open', 'closed', 'cancelled');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'pix', 'other');
CREATE TYPE channel AS ENUM ('balcao', 'whatsapp', 'web', 'ifood');
CREATE TYPE item_status AS ENUM ('ordered', 'ready', 'delivered', 'cancelled');
CREATE TYPE stock_movement_type AS ENUM ('sale', 'refund', 'purchase', 'adjustment');
CREATE TYPE cash_drawer_status AS ENUM ('open', 'closed');
CREATE TYPE cash_drawer_movement_type AS ENUM ('sangria', 'suprimento');
CREATE TYPE ifood_event_status AS ENUM ('received', 'processed', 'ignored', 'failed', 'acked');
CREATE TYPE whatsapp_state AS ENUM ('welcome', 'browsing', 'cart', 'checkout', 'done', 'awaiting_location', 'awaiting_confirmation', 'awaiting_correction');
CREATE TYPE delivery_status AS ENUM ('awaiting_courier', 'out_for_delivery', 'delivered', 'failed', 'cancelled');
CREATE TYPE table_status AS ENUM ('free', 'occupied', 'closing');
CREATE TYPE pix_key_type AS ENUM ('cpf', 'cnpj', 'email', 'phone', 'random');
CREATE TYPE idempotency_status AS ENUM ('processing', 'completed', 'failed');

-- Tabelas
CREATE TABLE IF NOT EXISTS "user" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role user_role NOT NULL,
  pin_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kitchen_group (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES category(id) ON DELETE SET NULL,
  kitchen_group_id UUID REFERENCES kitchen_group(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL,
  variations JSONB NOT NULL DEFAULT '[]',
  image_path TEXT,
  ifood_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ifood_sku TEXT,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  cost_price REAL NOT NULL DEFAULT 0,
  low_stock_threshold REAL NOT NULL DEFAULT 0,
  track_stock BOOLEAN NOT NULL DEFAULT FALSE,
  unit TEXT NOT NULL DEFAULT 'un',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL UNIQUE,
  status table_status NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "order" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID REFERENCES restaurant_table(id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES customer(id) ON DELETE SET NULL,
  tab_label TEXT,
  waiter_id UUID NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  status order_status NOT NULL DEFAULT 'open',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  payment_method payment_method,
  payment_confirmed_at TIMESTAMPTZ,
  payment_confirmed_by UUID REFERENCES "user"(id),
  channel channel NOT NULL DEFAULT 'balcao',
  external_ref TEXT,
  delivery_fee REAL,
  cancel_reason TEXT,
  ifood_payments JSONB
);

CREATE TABLE IF NOT EXISTS order_payment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  method payment_method NOT NULL,
  amount REAL NOT NULL,
  received REAL,
  change REAL,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES "user"(id),
  created_by UUID NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  selected_variations JSONB NOT NULL DEFAULT '{}',
  notes TEXT,
  status item_status NOT NULL DEFAULT 'ordered',
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  tax_id TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID REFERENCES supplier(id) ON DELETE SET NULL,
  invoice_number TEXT,
  issued_on TEXT,
  note TEXT,
  total REAL NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,
  line_total REAL NOT NULL DEFAULT 0,
  batch_no TEXT,
  expiry_date TEXT,
  created_by UUID NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_movement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  type stock_movement_type NOT NULL,
  quantity_delta REAL NOT NULL,
  unit_cost REAL,
  purchase_item_id UUID REFERENCES purchase_item(id) ON DELETE SET NULL,
  order_id UUID REFERENCES "order"(id) ON DELETE SET NULL,
  order_item_id UUID REFERENCES order_item(id) ON DELETE SET NULL,
  note TEXT,
  created_by UUID NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_drawer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status cash_drawer_status NOT NULL DEFAULT 'open',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by UUID NOT NULL REFERENCES "user"(id),
  opening_amount REAL NOT NULL DEFAULT 0,
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES "user"(id),
  closing_expected REAL,
  closing_counted REAL,
  closing_difference REAL,
  closing_note TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_drawer_movement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawer_id UUID NOT NULL REFERENCES cash_drawer(id) ON DELETE CASCADE,
  type cash_drawer_movement_type NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  ref_order_id UUID REFERENCES "order"(id),
  created_by UUID NOT NULL REFERENCES "user"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_settings (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  merchant_name TEXT NOT NULL,
  merchant_city TEXT NOT NULL,
  logo_path TEXT,
  brand_color TEXT NOT NULL DEFAULT '#f59e0b',
  pix_key TEXT NOT NULL DEFAULT '',
  pix_key_type pix_key_type NOT NULL DEFAULT 'phone',
  uses_tables BOOLEAN NOT NULL DEFAULT TRUE,
  kitchen_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  uses_delivery BOOLEAN NOT NULL DEFAULT TRUE,
  ifood_integration_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  inventory_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  purchase_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_payment_methods JSONB NOT NULL DEFAULT '["cash","card","pix","other"]',
  kitchen_prep_warn_min INTEGER NOT NULL DEFAULT 3,
  kitchen_prep_urgent_min INTEGER NOT NULL DEFAULT 6,
  kitchen_pickup_urgent_min INTEGER NOT NULL DEFAULT 5,
  delivery_fee REAL NOT NULL DEFAULT 0,
  restaurant_lat REAL,
  restaurant_long REAL,
  free_delivery_min REAL NOT NULL DEFAULT 0,
  delivery_fee_tiers JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES "user"(id),
  action TEXT NOT NULL,
  order_id UUID REFERENCES "order"(id),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_key (
  correlation_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_body TEXT,
  response_status INTEGER,
  status idempotency_status NOT NULL DEFAULT 'processing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  room TEXT NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ifood_event (
  id TEXT PRIMARY KEY,
  order_ref TEXT,
  code TEXT NOT NULL,
  full_code TEXT,
  status ifood_event_status NOT NULL DEFAULT 'received',
  raw JSONB NOT NULL DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ifood_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_address (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  label TEXT,
  street TEXT NOT NULL,
  number TEXT NOT NULL,
  complement TEXT,
  neighborhood TEXT NOT NULL,
  city TEXT NOT NULL,
  reference TEXT,
  latitude REAL,
  longitude REAL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_conversation (
  phone TEXT PRIMARY KEY,
  state whatsapp_state NOT NULL DEFAULT 'welcome',
  cart_items JSONB NOT NULL DEFAULT '[]',
  customer_name TEXT,
  delivery_address TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES "order"(id) ON DELETE CASCADE,
  courier_id UUID REFERENCES "user"(id) ON DELETE SET NULL,
  address TEXT NOT NULL,
  distance_km REAL,
  estimated_minutes INTEGER,
  status delivery_status NOT NULL DEFAULT 'awaiting_courier',
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_cart (
  phone TEXT PRIMARY KEY,
  items JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS geocoding_cache (
  cache_key TEXT PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

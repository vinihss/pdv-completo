-- 0001_init.sql — baseline único consolidado do schema PDV.
-- Gerado a partir do pg_dump --schema-only do banco na cadeia antiga (0001..0012, pós-0012).
-- Idempotente: sem CREATE INDEX CONCURRENTLY; tipos e constraints protegidos por DO blocks.

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


--
-- Name: cash_drawer_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.cash_drawer_status AS ENUM (
    'open',
    'closed'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_movement_type; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.cash_movement_type AS ENUM (
    'sangria',
    'suprimento'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: channel; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.channel AS ENUM (
    'balcao',
    'whatsapp',
    'web',
    'ifood'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: delivery_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.delivery_status AS ENUM (
    'awaiting_courier',
    'out_for_delivery',
    'delivered',
    'failed',
    'cancelled'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: idempotency_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.idempotency_status AS ENUM (
    'processing',
    'completed',
    'failed'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: ifood_event_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.ifood_event_status AS ENUM (
    'received',
    'processed',
    'ignored',
    'failed',
    'acked'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_item_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.order_item_status AS ENUM (
    'ordered',
    'ready',
    'delivered',
    'cancelled'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.order_status AS ENUM (
    'open',
    'closed',
    'cancelled'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: payment_method; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.payment_method AS ENUM (
    'cash',
    'card',
    'pix',
    'other'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: pix_key_type; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.pix_key_type AS ENUM (
    'cpf',
    'cnpj',
    'email',
    'phone',
    'random'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: stock_movement_type; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.stock_movement_type AS ENUM (
    'sale',
    'refund',
    'purchase',
    'adjustment'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: table_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.table_status AS ENUM (
    'free',
    'occupied',
    'closing'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.user_role AS ENUM (
    'waiter',
    'kitchen',
    'manager',
    'courier',
    'system',
    'cashier'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_connection_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.whatsapp_connection_status AS ENUM (
    'active',
    'expired',
    'revoked',
    'disconnected'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_message_kind; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.whatsapp_message_kind AS ENUM (
    'notification',
    'bot_reply'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_message_status; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.whatsapp_message_status AS ENUM (
    'sent',
    'delivered',
    'read',
    'failed'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_state; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN CREATE TYPE public.whatsapp_state AS ENUM (
    'welcome',
    'browsing',
    'cart',
    'checkout',
    'done',
    'awaiting_location',
    'awaiting_confirmation',
    'awaiting_correction'
); EXCEPTION WHEN OTHERS THEN NULL; END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;


--
-- Name: alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.alert (
    id text NOT NULL,
    seq bigint NOT NULL,
    kind text DEFAULT 'order_created'::text NOT NULL,
    title text NOT NULL,
    body text,
    order_id text,
    channel text,
    audience_roles text[],
    read_at text,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: alert_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.alert_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alert_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alert_seq_seq OWNED BY public.alert.seq;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.audit_log (
    id text NOT NULL,
    user_id text NOT NULL,
    action text NOT NULL,
    order_id text,
    details text DEFAULT '{}'::text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: cash_drawer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.cash_drawer (
    id text NOT NULL,
    status public.cash_drawer_status DEFAULT 'open'::public.cash_drawer_status NOT NULL,
    opened_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    opened_by text NOT NULL,
    opening_amount real DEFAULT 0 NOT NULL,
    closed_at text,
    closed_by text,
    closing_expected real,
    closing_counted real,
    closing_difference real,
    closing_note text,
    note text,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: cash_drawer_movement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.cash_drawer_movement (
    id text NOT NULL,
    drawer_id text NOT NULL,
    type public.cash_movement_type NOT NULL,
    amount real NOT NULL,
    note text,
    ref_order_id text,
    created_by text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.category (
    id text NOT NULL,
    name text NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: customer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.customer (
    id text NOT NULL,
    name text NOT NULL,
    phone text,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    email text,
    active boolean DEFAULT true NOT NULL,
    photo_path text,
    cpf text,
    notes text
);


--
-- Name: customer_address; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.customer_address (
    id text NOT NULL,
    customer_id text NOT NULL,
    label text,
    street text NOT NULL,
    number text NOT NULL,
    complement text,
    neighborhood text NOT NULL,
    city text NOT NULL,
    reference text,
    latitude real,
    longitude real,
    is_default boolean DEFAULT false NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    cep text,
    state text
);


--
-- Name: customer_cart; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.customer_cart (
    phone text NOT NULL,
    items text DEFAULT '[]'::text NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: delivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.delivery (
    id text NOT NULL,
    order_id text NOT NULL,
    courier_id text,
    address text NOT NULL,
    distance_km real,
    estimated_minutes integer,
    status public.delivery_status DEFAULT 'awaiting_courier'::public.delivery_status NOT NULL,
    dispatched_at text,
    delivered_at text,
    notes text,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: geocoding_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.geocoding_cache (
    cache_key text NOT NULL,
    response text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: idempotency_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.idempotency_key (
    correlation_id text NOT NULL,
    endpoint text NOT NULL,
    request_hash text NOT NULL,
    response_body text,
    response_status integer,
    status public.idempotency_status DEFAULT 'processing'::public.idempotency_status NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: ifood_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ifood_event (
    id text NOT NULL,
    order_ref text,
    code text NOT NULL,
    full_code text,
    status public.ifood_event_status DEFAULT 'received'::public.ifood_event_status NOT NULL,
    raw text DEFAULT '{}'::text NOT NULL,
    processed_at text,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: ifood_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ifood_state (
    key text NOT NULL,
    value text NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: kitchen_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.kitchen_group (
    id text NOT NULL,
    name text NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public."order" (
    id text NOT NULL,
    table_id text,
    customer_id text,
    tab_label text,
    waiter_id text NOT NULL,
    status public.order_status DEFAULT 'open'::public.order_status NOT NULL,
    opened_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    closed_at text,
    payment_method public.payment_method,
    payment_confirmed_at text,
    payment_confirmed_by text,
    channel public.channel DEFAULT 'balcao'::public.channel NOT NULL,
    external_ref text,
    delivery_fee real,
    cancel_reason text,
    ifood_payments text,
    notes text,
    CONSTRAINT chk_order_identification_required CHECK (((table_id IS NOT NULL) OR (customer_id IS NOT NULL) OR (tab_label IS NOT NULL)))
);


--
-- Name: order_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.order_item (
    id text NOT NULL,
    order_id text NOT NULL,
    product_id text NOT NULL,
    quantity integer NOT NULL,
    unit_price real NOT NULL,
    cost_price real DEFAULT 0 NOT NULL,
    selected_variations text DEFAULT '{}'::text NOT NULL,
    notes text,
    status public.order_item_status DEFAULT 'ordered'::public.order_item_status NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    CONSTRAINT order_item_quantity_check CHECK ((quantity > 0))
);


--
-- Name: order_payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.order_payment (
    id text NOT NULL,
    order_id text NOT NULL,
    method public.payment_method NOT NULL,
    amount real NOT NULL,
    received real,
    change real,
    confirmed boolean DEFAULT false NOT NULL,
    confirmed_at text,
    confirmed_by text,
    created_by text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    CONSTRAINT order_payment_amount_check CHECK ((amount > (0)::double precision))
);


--
-- Name: outbox_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.outbox_event (
    id text NOT NULL,
    seq bigint NOT NULL,
    event_type text NOT NULL,
    payload text NOT NULL,
    room text NOT NULL,
    published boolean DEFAULT false NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: outbox_event_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.outbox_event_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbox_event_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbox_event_seq_seq OWNED BY public.outbox_event.seq;


--
-- Name: product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.product (
    id text NOT NULL,
    category_id text,
    kitchen_group_id text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    price real NOT NULL,
    variations text DEFAULT '[]'::text NOT NULL,
    image_path text,
    ifood_enabled boolean DEFAULT false NOT NULL,
    ifood_sku text,
    featured boolean DEFAULT false NOT NULL,
    cost_price real DEFAULT 0 NOT NULL,
    low_stock_threshold real DEFAULT 0 NOT NULL,
    track_stock boolean DEFAULT false NOT NULL,
    unit text DEFAULT 'un'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    CONSTRAINT product_price_check CHECK ((price >= (0)::double precision))
);


--
-- Name: purchase; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.purchase (
    id text NOT NULL,
    supplier_id text,
    invoice_number text,
    issued_on text,
    note text,
    total real DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: purchase_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.purchase_item (
    id text NOT NULL,
    seq bigint NOT NULL,
    purchase_id text NOT NULL,
    product_id text NOT NULL,
    quantity real NOT NULL,
    unit_cost real NOT NULL,
    line_total real DEFAULT 0 NOT NULL,
    batch_no text,
    expiry_date text,
    created_by text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: purchase_item_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.purchase_item_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_item_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_item_seq_seq OWNED BY public.purchase_item.seq;


--
-- Name: restaurant_table; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.restaurant_table (
    id text NOT NULL,
    number text NOT NULL,
    status public.table_status DEFAULT 'free'::public.table_status NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: stock_movement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.stock_movement (
    id text NOT NULL,
    seq bigint NOT NULL,
    product_id text NOT NULL,
    type public.stock_movement_type NOT NULL,
    quantity_delta real NOT NULL,
    unit_cost real,
    purchase_item_id text,
    order_id text,
    order_item_id text,
    note text,
    created_by text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: stock_movement_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.stock_movement_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_movement_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_movement_seq_seq OWNED BY public.stock_movement.seq;


--
-- Name: store_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.store_settings (
    id text DEFAULT 'singleton'::text NOT NULL,
    merchant_name text NOT NULL,
    merchant_city text NOT NULL,
    logo_path text,
    brand_color text DEFAULT '#f59e0b'::text NOT NULL,
    pix_key text DEFAULT ''::text NOT NULL,
    pix_key_type public.pix_key_type DEFAULT 'phone'::public.pix_key_type NOT NULL,
    uses_tables boolean DEFAULT true NOT NULL,
    kitchen_enabled boolean DEFAULT true NOT NULL,
    uses_delivery boolean DEFAULT true NOT NULL,
    ifood_integration_enabled boolean DEFAULT false NOT NULL,
    inventory_enabled boolean DEFAULT false NOT NULL,
    purchase_enabled boolean DEFAULT false NOT NULL,
    enabled_payment_methods text DEFAULT '["cash","card","pix","other"]'::text NOT NULL,
    kitchen_prep_warn_min integer DEFAULT 3 NOT NULL,
    kitchen_prep_urgent_min integer DEFAULT 6 NOT NULL,
    kitchen_pickup_urgent_min integer DEFAULT 5 NOT NULL,
    delivery_fee real DEFAULT 0 NOT NULL,
    restaurant_lat real,
    restaurant_long real,
    free_delivery_min real DEFAULT 0 NOT NULL,
    delivery_fee_tiers text DEFAULT '[]'::text NOT NULL,
    printer_enabled boolean DEFAULT false NOT NULL,
    printer_auto_print boolean DEFAULT false NOT NULL,
    delivery_prep_minutes integer DEFAULT 40 NOT NULL,
    minutes_per_km integer DEFAULT 2 NOT NULL,
    whatsapp_integration_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: supplier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.supplier (
    id text NOT NULL,
    name text NOT NULL,
    phone text,
    tax_id text,
    active boolean DEFAULT true NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public."user" (
    id text NOT NULL,
    name text NOT NULL,
    role public.user_role NOT NULL,
    pin_hash text NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until text,
    active boolean DEFAULT true NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    phone text,
    email text,
    photo_path text
);


--
-- Name: whatsapp_connection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.whatsapp_connection (
    id text NOT NULL,
    waba_id text NOT NULL,
    phone_number_id text NOT NULL,
    business_id text,
    business_name text,
    display_phone_number text,
    display_name text,
    access_token text NOT NULL,
    token_expires_at text,
    status public.whatsapp_connection_status DEFAULT 'active'::public.whatsapp_connection_status NOT NULL,
    last_error text,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: whatsapp_conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.whatsapp_conversation (
    phone text NOT NULL,
    state public.whatsapp_state DEFAULT 'welcome'::public.whatsapp_state NOT NULL,
    cart_items text DEFAULT '[]'::text NOT NULL,
    customer_name text,
    delivery_address text,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    expires_at text NOT NULL,
    waba_id text
);


--
-- Name: whatsapp_inbound_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.whatsapp_inbound_message (
    id text NOT NULL,
    waba_id text NOT NULL,
    from_phone text NOT NULL,
    type text NOT NULL,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: whatsapp_outbound_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.whatsapp_outbound_message (
    id text NOT NULL,
    waba_id text NOT NULL,
    order_id text,
    to_phone text NOT NULL,
    kind public.whatsapp_message_kind NOT NULL,
    status public.whatsapp_message_status DEFAULT 'sent'::public.whatsapp_message_status NOT NULL,
    error_code integer,
    error_message text,
    created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
    updated_at text DEFAULT to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);


--
-- Name: alert seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert ALTER COLUMN seq SET DEFAULT nextval('public.alert_seq_seq'::regclass);


--
-- Name: outbox_event seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_event ALTER COLUMN seq SET DEFAULT nextval('public.outbox_event_seq_seq'::regclass);


--
-- Name: purchase_item seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_item ALTER COLUMN seq SET DEFAULT nextval('public.purchase_item_seq_seq'::regclass);


--
-- Name: stock_movement seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movement ALTER COLUMN seq SET DEFAULT nextval('public.stock_movement_seq_seq'::regclass);



--
-- Name: alert alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.alert ADD CONSTRAINT alert_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_drawer_movement cash_drawer_movement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.cash_drawer_movement ADD CONSTRAINT cash_drawer_movement_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_drawer cash_drawer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.cash_drawer ADD CONSTRAINT cash_drawer_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: category category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.category ADD CONSTRAINT category_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: customer_address customer_address_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.customer_address ADD CONSTRAINT customer_address_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: customer_cart customer_cart_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.customer_cart ADD CONSTRAINT customer_cart_pkey PRIMARY KEY (phone); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: customer customer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.customer ADD CONSTRAINT customer_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: delivery delivery_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.delivery ADD CONSTRAINT delivery_order_id_key UNIQUE (order_id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: delivery delivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.delivery ADD CONSTRAINT delivery_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: geocoding_cache geocoding_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.geocoding_cache ADD CONSTRAINT geocoding_cache_pkey PRIMARY KEY (cache_key); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: idempotency_key idempotency_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.idempotency_key ADD CONSTRAINT idempotency_key_pkey PRIMARY KEY (correlation_id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: ifood_event ifood_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.ifood_event ADD CONSTRAINT ifood_event_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: ifood_state ifood_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.ifood_state ADD CONSTRAINT ifood_state_pkey PRIMARY KEY (key); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: kitchen_group kitchen_group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.kitchen_group ADD CONSTRAINT kitchen_group_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_item order_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_item ADD CONSTRAINT order_item_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_payment order_payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_payment ADD CONSTRAINT order_payment_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public."order" ADD CONSTRAINT order_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: outbox_event outbox_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.outbox_event ADD CONSTRAINT outbox_event_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: product product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.product ADD CONSTRAINT product_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: purchase_item purchase_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.purchase_item ADD CONSTRAINT purchase_item_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: purchase purchase_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.purchase ADD CONSTRAINT purchase_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: restaurant_table restaurant_table_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.restaurant_table ADD CONSTRAINT restaurant_table_number_key UNIQUE (number); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: restaurant_table restaurant_table_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.restaurant_table ADD CONSTRAINT restaurant_table_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: stock_movement stock_movement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: store_settings store_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.store_settings ADD CONSTRAINT store_settings_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: supplier supplier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.supplier ADD CONSTRAINT supplier_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public."user" ADD CONSTRAINT user_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_connection whatsapp_connection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_connection ADD CONSTRAINT whatsapp_connection_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_connection whatsapp_connection_waba_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_connection ADD CONSTRAINT whatsapp_connection_waba_id_key UNIQUE (waba_id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_conversation whatsapp_conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_conversation ADD CONSTRAINT whatsapp_conversation_pkey PRIMARY KEY (phone); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_inbound_message whatsapp_inbound_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_inbound_message ADD CONSTRAINT whatsapp_inbound_message_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_outbound_message whatsapp_outbound_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_outbound_message ADD CONSTRAINT whatsapp_outbound_message_pkey PRIMARY KEY (id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: idx_alert_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_alert_created_at ON public.alert USING btree (created_at, seq);


--
-- Name: idx_alert_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_alert_order ON public.alert USING btree (order_id);


--
-- Name: idx_alert_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_alert_unread ON public.alert USING btree (created_at) WHERE (read_at IS NULL);


--
-- Name: idx_audit_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log USING btree (created_at);


--
-- Name: idx_audit_log_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_audit_log_order ON public.audit_log USING btree (order_id);


--
-- Name: idx_audit_log_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON public.audit_log USING btree (user_id);


--
-- Name: idx_cash_drawer_movement_drawer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_cash_drawer_movement_drawer ON public.cash_drawer_movement USING btree (drawer_id);


--
-- Name: idx_cash_drawer_opened_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_cash_drawer_opened_at ON public.cash_drawer USING btree (opened_at);


--
-- Name: idx_customer_address_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_customer_address_customer ON public.customer_address USING btree (customer_id);


--
-- Name: idx_customer_cart_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_customer_cart_expires ON public.customer_cart USING btree (expires_at);


--
-- Name: idx_customer_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_customer_name ON public.customer USING btree (name);


--
-- Name: idx_customer_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_customer_phone ON public.customer USING btree (phone);


--
-- Name: idx_delivery_courier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_delivery_courier ON public.delivery USING btree (courier_id);


--
-- Name: idx_delivery_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_delivery_status ON public.delivery USING btree (status);


--
-- Name: idx_geocoding_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_geocoding_cache_expires ON public.geocoding_cache USING btree (expires_at);


--
-- Name: idx_idempotency_key_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_idempotency_key_expires ON public.idempotency_key USING btree (expires_at);


--
-- Name: idx_ifood_event_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_ifood_event_status ON public.ifood_event USING btree (status);


--
-- Name: idx_order_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_order_customer ON public."order" USING btree (customer_id);


--
-- Name: idx_order_item_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_order_item_order ON public.order_item USING btree (order_id);


--
-- Name: idx_order_item_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_order_item_product ON public.order_item USING btree (product_id);


--
-- Name: idx_order_payment_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_order_payment_order ON public.order_payment USING btree (order_id);


--
-- Name: idx_order_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_order_status ON public."order" USING btree (status);


--
-- Name: idx_order_table; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_order_table ON public."order" USING btree (table_id);


--
-- Name: idx_order_waiter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_order_waiter ON public."order" USING btree (waiter_id);


--
-- Name: idx_outbox_event_unpublished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_outbox_event_unpublished ON public.outbox_event USING btree (created_at, seq) WHERE (published = false);


--
-- Name: idx_product_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_product_category ON public.product USING btree (category_id);


--
-- Name: idx_product_kitchen_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_product_kitchen_group ON public.product USING btree (kitchen_group_id);


--
-- Name: idx_purchase_item_purchase; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_purchase_item_purchase ON public.purchase_item USING btree (purchase_id);


--
-- Name: idx_stock_movement_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_stock_movement_order ON public.stock_movement USING btree (order_id);


--
-- Name: idx_stock_movement_order_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_stock_movement_order_item ON public.stock_movement USING btree (order_item_id);


--
-- Name: idx_stock_movement_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_stock_movement_product ON public.stock_movement USING btree (product_id);


--
-- Name: idx_stock_movement_product_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_stock_movement_product_seq ON public.stock_movement USING btree (product_id, seq);


--
-- Name: idx_whatsapp_inbound_waba; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_waba ON public.whatsapp_inbound_message USING btree (waba_id);


--
-- Name: idx_whatsapp_outbound_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_order ON public.whatsapp_outbound_message USING btree (order_id);


--
-- Name: idx_whatsapp_outbound_waba_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_waba_created ON public.whatsapp_outbound_message USING btree (waba_id, created_at);


--
-- Name: uq_cash_drawer_single_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_drawer_single_open ON public.cash_drawer USING btree (status) WHERE (status = 'open'::public.cash_drawer_status);


--
-- Name: uq_customer_cpf; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_cpf ON public.customer USING btree (cpf) WHERE (cpf IS NOT NULL);


--
-- Name: uq_customer_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_email ON public.customer USING btree (email) WHERE (email IS NOT NULL);


--
-- Name: uq_order_channel_external_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_channel_external_ref ON public."order" USING btree (channel, external_ref);


--
-- Name: uq_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_email ON public."user" USING btree (email) WHERE (email IS NOT NULL);


--
-- Name: uq_whatsapp_single_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_single_active ON public.whatsapp_connection USING btree ((true)) WHERE (status = 'active'::public.whatsapp_connection_status);


--
-- Name: alert alert_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.alert ADD CONSTRAINT alert_order_id_fkey FOREIGN KEY (order_id) REFERENCES public."order"(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: audit_log audit_log_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.audit_log ADD CONSTRAINT audit_log_order_id_fkey FOREIGN KEY (order_id) REFERENCES public."order"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.audit_log ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_drawer cash_drawer_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.cash_drawer ADD CONSTRAINT cash_drawer_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_drawer_movement cash_drawer_movement_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.cash_drawer_movement ADD CONSTRAINT cash_drawer_movement_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_drawer_movement cash_drawer_movement_drawer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.cash_drawer_movement ADD CONSTRAINT cash_drawer_movement_drawer_id_fkey FOREIGN KEY (drawer_id) REFERENCES public.cash_drawer(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_drawer_movement cash_drawer_movement_ref_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.cash_drawer_movement ADD CONSTRAINT cash_drawer_movement_ref_order_id_fkey FOREIGN KEY (ref_order_id) REFERENCES public."order"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: cash_drawer cash_drawer_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.cash_drawer ADD CONSTRAINT cash_drawer_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: customer_address customer_address_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.customer_address ADD CONSTRAINT customer_address_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: delivery delivery_courier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.delivery ADD CONSTRAINT delivery_courier_id_fkey FOREIGN KEY (courier_id) REFERENCES public."user"(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: delivery delivery_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.delivery ADD CONSTRAINT delivery_order_id_fkey FOREIGN KEY (order_id) REFERENCES public."order"(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order order_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public."order" ADD CONSTRAINT order_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_item order_item_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_item ADD CONSTRAINT order_item_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_item order_item_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_item ADD CONSTRAINT order_item_order_id_fkey FOREIGN KEY (order_id) REFERENCES public."order"(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_item order_item_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_item ADD CONSTRAINT order_item_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON DELETE RESTRICT; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order order_payment_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public."order" ADD CONSTRAINT order_payment_confirmed_by_fkey FOREIGN KEY (payment_confirmed_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_payment order_payment_confirmed_by_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_payment ADD CONSTRAINT order_payment_confirmed_by_fkey1 FOREIGN KEY (confirmed_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_payment order_payment_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_payment ADD CONSTRAINT order_payment_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order_payment order_payment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.order_payment ADD CONSTRAINT order_payment_order_id_fkey FOREIGN KEY (order_id) REFERENCES public."order"(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order order_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public."order" ADD CONSTRAINT order_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.restaurant_table(id) ON DELETE RESTRICT; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: order order_waiter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public."order" ADD CONSTRAINT order_waiter_id_fkey FOREIGN KEY (waiter_id) REFERENCES public."user"(id) ON DELETE RESTRICT; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: product product_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.product ADD CONSTRAINT product_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.category(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: product product_kitchen_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.product ADD CONSTRAINT product_kitchen_group_id_fkey FOREIGN KEY (kitchen_group_id) REFERENCES public.kitchen_group(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: purchase purchase_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.purchase ADD CONSTRAINT purchase_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: purchase_item purchase_item_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.purchase_item ADD CONSTRAINT purchase_item_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: purchase_item purchase_item_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.purchase_item ADD CONSTRAINT purchase_item_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON DELETE RESTRICT; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: purchase_item purchase_item_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.purchase_item ADD CONSTRAINT purchase_item_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchase(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: purchase purchase_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.purchase ADD CONSTRAINT purchase_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.supplier(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: stock_movement stock_movement_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id); EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: stock_movement stock_movement_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_order_id_fkey FOREIGN KEY (order_id) REFERENCES public."order"(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: stock_movement stock_movement_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_item(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: stock_movement stock_movement_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: stock_movement stock_movement_purchase_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_purchase_item_id_fkey FOREIGN KEY (purchase_item_id) REFERENCES public.purchase_item(id) ON DELETE SET NULL; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_inbound_message whatsapp_inbound_message_waba_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_inbound_message ADD CONSTRAINT whatsapp_inbound_message_waba_id_fkey FOREIGN KEY (waba_id) REFERENCES public.whatsapp_connection(waba_id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_outbound_message whatsapp_outbound_message_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_outbound_message ADD CONSTRAINT whatsapp_outbound_message_order_id_fkey FOREIGN KEY (order_id) REFERENCES public."order"(id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


--
-- Name: whatsapp_outbound_message whatsapp_outbound_message_waba_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $$ BEGIN ALTER TABLE ONLY public.whatsapp_outbound_message ADD CONSTRAINT whatsapp_outbound_message_waba_id_fkey FOREIGN KEY (waba_id) REFERENCES public.whatsapp_connection(waba_id) ON DELETE CASCADE; EXCEPTION WHEN OTHERS THEN NULL; END $$;


-- Conta técnica usada pelos pedidos self-service (migrada da cadeia antiga).
INSERT INTO "user" (id, name, role, pin_hash, active)
VALUES ('system', 'Pedidos automáticos (self-service)', 'system', 'SYSTEM_ACCOUNT_NO_LOGIN', false)
ON CONFLICT (id) DO NOTHING;

--
-- PostgreSQL database dump complete
--



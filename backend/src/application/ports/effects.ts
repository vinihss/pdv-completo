/**
 * Ports de efeitos colaterais não-transacionais — FASE 0 da refatoração.
 * Contrato CONGELADO.
 *
 * Cada port espelha uma seam que já existe no código (comentário em cada um);
 * a tradução para a implementação atual acontece nos adapters, nas ondas
 * seguintes. A ONDA 2 passou a injetá-los no hub de pedidos
 * (`application/order/order.usecases.ts` → factory `createOrderUsecases`):
 * `TenantCache`, `StoreSettingsReader` e `OrderPrinter`.
 */
import type { Id, Json } from "./repositories.js";

// ---------- storage de arquivos (espelha `infra/storage`: STORAGE_KINDS + FileStorage) ----------

export type FileKind = "product" | "logo" | "customer" | "user";

export interface FileStorage {
  put(kind: FileKind, filename: string, content: Buffer): Promise<void>;
  remove(kind: FileKind, filename: string): Promise<void>;
}

// ---------- cache por tenant (espelha `infra/cache` → tenantCache) ----------

export interface TenantCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
  /** Invalida TODAS as chaves sob o prefixo (adapter atual: `invalidatePattern(\`${prefix}*\`)`). */
  invalidatePrefix(prefix: string): Promise<void>;
}

// ---------- settings da loja (espelha `getSettings` de order.usecases) ----------

/**
 * ADIÇÃO (Onda 2): leitura do singleton `store_settings`.
 *
 * `store_settings` tem 40+ colunas; este record traz EXATAMENTE os campos que
 * os consumidores de `getSettings()` usam hoje (hub de pedidos + self-service
 * + contexto delivery). Ajustar aqui é explícito — mudar o settings passa a
 * ser diff visível, e não uma leitura esquecida num use case distante.
 */
export interface StoreSettingsRecord {
  kitchenEnabled: boolean;
  inventoryEnabled: boolean;
  purchaseEnabled: boolean;
  printerEnabled: boolean;
  printerAutoPrint: boolean;
  /** JSON string de `["cash","card",...]` — o use case faz o parse (como hoje). */
  enabledPaymentMethods: string;
  deliveryFee: number;
  /** JSON string das faixas de frete — o use case faz o parse (como hoje). */
  deliveryFeeTiers: string;
  deliveryPrepMinutes: number;
  minutesPerKm: number;
  /** ADIÇÃO (Onda 3 — delivery): endereço do estabelecimento (geocode-restaurant monta `${merchantName}, ${merchantCity}`). */
  merchantName: string;
  merchantCity: string;
  /** ADIÇÃO (Onda 3 — delivery): coordenadas do restaurante (origem da rota). NULL = não configurado. */
  restaurantLat: number | null;
  restaurantLong: number | null;
  /** ADIÇÃO (Onda 3 — delivery): total de itens a partir do qual o frete é grátis (0 = desligado). */
  freeDeliveryMin: number;
  /** ADIÇÃO (Onda tenant): marca da loja consumida pela vitrine pública (`GET /public/tenants/resolve`). */
  logoPath: string | null;
  brandColor: string;
  usesDelivery: boolean;
}

export interface StoreSettingsReader {
  /** Lança se o singleton não existir (mensagem igual à de `getSettings` atual). */
  get(): Promise<StoreSettingsRecord>;
}

// ---------- mapas (espelha `integrations/maps/types.ts`) ----------

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface GeocodedAddress {
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  formattedAddress: string;
}

export interface RoutingResult {
  distanceKm: number;
  durationMinutes: number;
}

export interface GeocodingService {
  reverseGeocode(coords: Coordinates): Promise<GeocodedAddress>;
  forwardGeocode(address: string): Promise<Coordinates>;
}

export interface RoutingService {
  calculateRoute(origin: Coordinates, destination: Coordinates): Promise<RoutingResult>;
}

// ---------- notificação realtime (espelha o uso de `enqueueEvent(tx, room, type, payload)`) ----------

export interface OrderNotifier {
  notify(input: { room: string; type: string; aggregateId?: Id; payload?: Json }): Promise<void>;
}

// ---------- impressão térmica (espelha `integrations/printer` → printerClient.enqueuePrint) ----------

export interface PrintJob {
  /** Idempotência do job no daemon. */
  jobId: string;
  orderId: Id;
  /** Destino físico ("cozinha", "caixa", ...). */
  destination: string;
  /** Cupom já formatado pelo mapper (o port não conhehe o layout). */
  payload: Json;
}

export interface Printer {
  enqueue(job: PrintJob): Promise<void>;
}

/**
 * ADIÇÃO (Onda 2): impressão pós-commit do pedido (`printKitchenOrder`).
 *
 * Por que um port dedicado e não o `Printer` acima: `Printer.enqueue` exige o
 * payload JÁ FORMATADO (o `DaemonOrder` do mapper de cupom, que mora em
 * `integrations/printer` — a application não pode importá-lo, nem conhece
 * layout de cupom). O use case tem o `orderId`, não o cupom: este port dá a
 * granularidade certa ("imprimir a comanda da cozinha desta comanda"), e o
 * adapter delega à função `printKitchenOrder` existente — mesmo cupom, mesma
 * semântica fire-and-forget (`printerClient` nunca lança; daemon tem retry).
 */
export interface OrderPrinter {
  printKitchenOrder(orderId: Id): Promise<void>;
  /**
   * ADIÇÃO (Onda 3 — self-service): cupom do entregador (`printCourierOrder`).
   * Mesma semântica fire-and-forget do cupom da cozinha, só muda o
   * `destination` resolvido no adapter.
   */
  printCourierOrder(orderId: Id): Promise<void>;
}

// ---------- e-mail (espelha `infra/mail` → MailerTransport.send) ----------

export interface MailerSendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string; cid?: string }>;
}

export interface MailerSendResult {
  sent: boolean;
  reason?: "not_configured" | "error";
  messageId?: string;
  error?: string;
}

export interface Mailer {
  send(input: MailerSendInput): Promise<MailerSendResult>;
}

// ---------- idempotência de endpoints (espelha `withIdempotency` do middleware) ----------

export interface IdempotencyStore {
  execute<T>(input: {
    endpoint: string;
    correlationId: string;
    /** Corpo da requisição — o adapter faz o hash SHA-256 como o middleware faz hoje. */
    body: unknown;
    handler: () => Promise<{ status: number; body: T }>;
  }): Promise<{ status: number; body: T }>;
}

// ---------- registry de tenants (espelha `infra/tenant/registry.ts`) ----------

/**
 * ADIÇÃO (Onda tenant): linha do registry `public.tenant` — a tabela de
 * controle do multi-tenant (`docs/15` §3.2). `schemaName` é topologia interna
 * e NUNCA vai para o cliente; o cache (TTL) e o SQL cru moram no adapter.
 */
export interface TenantRegistryRecord {
  slug: string;
  schemaName: string;
  displayName: string;
  status: "active" | "suspended";
  customDomain: string | null;
}

export interface TenantRegistry {
  /** Tenant pelo `slug` (a 1ª label do subdomínio). `null` = não existe. */
  findBySlug(slug: string): Promise<TenantRegistryRecord | null>;
  /** Tenant pelo domínio próprio (`umamisushiarte.com.br`). */
  findByCustomDomain(host: string): Promise<TenantRegistryRecord | null>;
}

// ---------- marca pública do tenant (vitrine de pedidos) ----------

/** Identidade + marca que a vitrine de pedidos recebe (`GET /public/tenants/resolve`). */
export interface PublicTenantBrand {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  usesDelivery: boolean;
  kitchenEnabled: boolean;
}

/**
 * ADIÇÃO (Onda tenant): leitura da marca pública DENTRO do escopo do tenant
 * resolvido (ALS + pool por schema, Fase 2). Encapsula o `runInTenantScope` e
 * a checagem explícita de provisionamento (`information_schema.tables`) — a
 * application não pode importar `infra/db`. O `search_path` do pool cai para
 * `public` em silêncio quando o schema não existe, por isso a checagem é
 * explícita: schema do tenant sem `store_settings` → `tenant_schema_unavailable`.
 */
export interface PublicTenantBrandReader {
  read(tenant: { slug: string; schemaName: string; isDefault: boolean }): Promise<PublicTenantBrand>;
}

// ---------- escopo de tenant do request (ALS) ----------

/**
 * ADIÇÃO (Onda auth): acesso ao escopo de tenant do request corrente.
 *
 * O `login.usecase` precisa consultar/entrar no escopo (o workaround de
 * propagação do ALS no Fastify resolve o tenant pelo host quando o ALS está
 * vazio) e NÃO pode importar `infra/db/tenant-context`. Este port encapsula
 * `currentTenantScope`/`enterTenantScope`; o adapter (infra) continua sendo o
 * único que conhece o ALS.
 */
export interface TenantScopeStore {
  /** Escopo corrente (ALS), ou `undefined` fora de um request. */
  current(): { slug: string; schemaName: string; isDefault: boolean } | undefined;
  /** Entra no escopo corrente (workaround de propagação do ALS no login). */
  enter(scope: { slug: string; schemaName: string; isDefault: boolean }): void;
}

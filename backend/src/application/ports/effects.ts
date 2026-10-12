/**
 * Ports de efeitos colaterais não-transacionais — FASE 0 da refatoração.
 * Contrato CONGELADO.
 *
 * Cada port espelha uma seam que já existe no código (comentário em cada um);
 * a tradução para a implementação atual acontece nos adapters, nas ondas
 * seguintes. Nenhum use case consome estes ports ainda.
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

// ---------- gateway de pagamento (espelha `domain/payment.ts` → PaymentGateway) ----------

export interface PaymentChargeRequest {
  orderId: Id;
  amount: number;
  method: "pix" | "credit_card";
  customerName?: string;
  customerEmail?: string;
  customerDocument?: string;
  metadata?: Json;
}

export interface PaymentChargeResult {
  providerOrderId: string;
  providerChargeId?: string | null;
  providerPaymentId?: string | null;
  status: string;
  qrCode?: string | null;
  qrCodeBase64?: string | null;
  qrCodeUrl?: string | null;
  pixTxid?: string | null;
  pixExpiresAt?: string | null;
  raw?: Json;
}

export interface PaymentGateway {
  createCharge(request: PaymentChargeRequest): Promise<PaymentChargeResult>;
  /** `amount` ausente = estorno integral. Confirmação de estado é do webhook (spec §20). */
  refund(input: { providerOrderId: string; amount?: number }): Promise<{ providerRefundId?: string }>;
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

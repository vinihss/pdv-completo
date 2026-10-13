/**
 * Port de configuração da loja — singleton `store_settings` e o cache
 * persistente de geocoding (`geocoding_cache`).
 *
 * A LEITURA de settings fora de transação é o effect port `StoreSettingsReader`
 * (`ports/effects.ts`); aqui entra o que nasce na janela transacional.
 *
 * Contrato CONGELADO: os use cases falam com estas interfaces; o adapter
 * Postgres (`src/infra/db/repositories/store-settings.repository.ts`) traduz
 * para Drizzle/schema.
 */
import type { Id, PixKeyType } from "../../ports/repositories/shared.js";

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

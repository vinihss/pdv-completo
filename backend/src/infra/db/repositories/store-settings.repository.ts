import { eq } from "drizzle-orm";
import type { Tx } from "../client.js";
import { geocodingCache, storeSettings } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import type {
  GeocodingCacheRepository,
  PixKeyType,
  StoreSettingsRepository,
  StoreSettingsRow,
  StoreSettingsUpdateInput,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Delivery — store_settings (escrita) e cache de geocoding (Onda 3)
// =====================================================================

/** Linha completa do singleton `store_settings` (todas as colunas do schema). */
function toStoreSettingsRow(s: typeof storeSettings.$inferSelect): StoreSettingsRow {
  return {
    id: s.id,
    merchantName: s.merchantName,
    merchantCity: s.merchantCity,
    logoPath: s.logoPath,
    brandColor: s.brandColor,
    pixKey: s.pixKey,
    pixKeyType: s.pixKeyType as PixKeyType,
    usesTables: s.usesTables,
    kitchenEnabled: s.kitchenEnabled,
    usesDelivery: s.usesDelivery,
    inventoryEnabled: s.inventoryEnabled,
    purchaseEnabled: s.purchaseEnabled,
    printerEnabled: s.printerEnabled,
    printerAutoPrint: s.printerAutoPrint,
    enabledPaymentMethods: s.enabledPaymentMethods,
    kitchenPrepWarnMin: s.kitchenPrepWarnMin,
    kitchenPrepUrgentMin: s.kitchenPrepUrgentMin,
    kitchenPickupUrgentMin: s.kitchenPickupUrgentMin,
    deliveryFee: s.deliveryFee,
    restaurantLat: s.restaurantLat,
    restaurantLong: s.restaurantLong,
    freeDeliveryMin: s.freeDeliveryMin,
    deliveryFeeTiers: s.deliveryFeeTiers,
    deliveryPrepMinutes: s.deliveryPrepMinutes,
    minutesPerKm: s.minutesPerKm,
    cashClosingTolerance: s.cashClosingTolerance,
    cashClosingRequireApprovalAbove: s.cashClosingRequireApprovalAbove,
    cashHighValueThreshold: s.cashHighValueThreshold,
  };
}

export class PostgresStoreSettingsRepository implements StoreSettingsRepository {
  constructor(private readonly tx: Tx) {}

  /**
   * `UPDATE store_settings SET restaurant_lat, restaurant_long WHERE id =
   * 'singleton'` — mesma escrita que `geocodeRestaurantUsecase` fazia dentro do
   * `db.transaction`. Nada além das duas coordenadas: o restante da linha é
   * território do `store-settings.usecases` (PUT /store-settings).
   */
  async updateRestaurantCoordinates(input: { latitude: number; longitude: number }): Promise<void> {
    await this.tx
      .update(storeSettings)
      .set({ restaurantLat: input.latitude, restaurantLong: input.longitude })
      .where(eq(storeSettings.id, "singleton"));
  }

  /** ADIÇÃO (Onda 3C): linha completa do singleton — `null` quando não existe. */
  async findSingleton(): Promise<StoreSettingsRow | null> {
    const row = await this.tx.query.storeSettings.findFirst({ where: eq(storeSettings.id, "singleton") });
    return row ? toStoreSettingsRow(row) : null;
  }

  /**
   * ADIÇÃO (Onda 3C): UPDATE de todos os campos do PUT /store-settings. O
   * `pixKey` já chega canônico (o use case roda `canonicalizePixKey` antes) e
   * os campos JSON chegam como estrutura — o adapter serializa (mesmos
   * defaults de antes: `freeDeliveryMin 0`, `deliveryFeeTiers []`,
   * `deliveryPrepMinutes 40`, `minutesPerKm 2`).
   */
  async update(input: StoreSettingsUpdateInput): Promise<StoreSettingsRow> {
    const [row] = await this.tx
      .update(storeSettings)
      .set({
        merchantName: input.merchantName,
        merchantCity: input.merchantCity,
        brandColor: input.brandColor,
        pixKey: input.pixKey,
        pixKeyType: input.pixKeyType,
        usesTables: input.usesTables,
        kitchenEnabled: input.kitchenEnabled,
        usesDelivery: input.usesDelivery,
        inventoryEnabled: input.inventoryEnabled,
        purchaseEnabled: input.purchaseEnabled,
        printerEnabled: input.printerEnabled,
        printerAutoPrint: input.printerAutoPrint,
        enabledPaymentMethods: JSON.stringify(input.enabledPaymentMethods),
        kitchenPrepWarnMin: input.kitchenPrepWarnMin,
        kitchenPrepUrgentMin: input.kitchenPrepUrgentMin,
        kitchenPickupUrgentMin: input.kitchenPickupUrgentMin,
        deliveryFee: input.deliveryFee,
        restaurantLat: input.restaurantLat ?? null,
        restaurantLong: input.restaurantLong ?? null,
        freeDeliveryMin: input.freeDeliveryMin ?? 0,
        deliveryFeeTiers: JSON.stringify(input.deliveryFeeTiers ?? []),
        deliveryPrepMinutes: input.deliveryPrepMinutes ?? 40,
        minutesPerKm: input.minutesPerKm ?? 2,
      })
      .where(eq(storeSettings.id, "singleton"))
      .returning();
    if (!row) throw Errors.notFound("Configuração da loja");
    return toStoreSettingsRow(row);
  }

  /** ADIÇÃO (Onda 3C): grava/limpa `logo_path` (upload/remoção do logo). */
  async setLogoPath(filename: string | null): Promise<StoreSettingsRow> {
    const [row] = await this.tx
      .update(storeSettings)
      .set({ logoPath: filename })
      .where(eq(storeSettings.id, "singleton"))
      .returning();
    if (!row) throw Errors.notFound("Configuração da loja");
    return toStoreSettingsRow(row);
  }
}

export class PostgresGeocodingCacheRepository implements GeocodingCacheRepository {
  constructor(private readonly tx: Tx) {}

  /** Linha crua por `cache_key` — a decisão de expiração é do use case. */
  async find(cacheKey: string): Promise<{ response: string; expiresAt: string } | null> {
    const row = await this.tx.query.geocodingCache.findFirst({
      where: eq(geocodingCache.cacheKey, cacheKey),
    });
    if (!row) return null;
    return { response: row.response, expiresAt: row.expiresAt };
  }

  /** Upsert por `cache_key` (mesmo `onConflictDoUpdate` da versão legada). */
  async upsert(input: { cacheKey: string; response: string; expiresAt: string }): Promise<void> {
    await this.tx
      .insert(geocodingCache)
      .values({
        cacheKey: input.cacheKey,
        response: input.response,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: geocodingCache.cacheKey,
        set: { response: input.response, expiresAt: input.expiresAt },
      });
  }
}


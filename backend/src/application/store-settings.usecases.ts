import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../infra/db/client.js";
import { storeSettings } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { canonicalizePixKey } from "../domain/pix-key.js";
import { config } from "../config/env.js";
import { logAction } from "../infra/audit-log.js";
import { getCache } from "../infra/cache/index.js";
import { NominatimGeocodingService } from "../integrations/maps/geocoding.service.js";

const cache = getCache();

function invalidateStoreSettingsRelated(storeId: string) {
  cache.invalidate(`store-settings:${storeId}`);
}

function serialize(s: typeof storeSettings.$inferSelect) {
  return {
    merchantName: s.merchantName,
    merchantCity: s.merchantCity,
    logoUrl: s.logoPath ? `/uploads/${s.logoPath}` : null,
    brandColor: s.brandColor,
    pixKey: s.pixKey,
    pixKeyType: s.pixKeyType,
    usesTables: s.usesTables,
    kitchenEnabled: s.kitchenEnabled,
    usesDelivery: s.usesDelivery,
    ifoodIntegrationEnabled: s.ifoodIntegrationEnabled,
    whatsappIntegrationEnabled: s.whatsappIntegrationEnabled,
    inventoryEnabled: s.inventoryEnabled,
    purchaseEnabled: s.purchaseEnabled,
    printerEnabled: s.printerEnabled,
    printerAutoPrint: s.printerAutoPrint,
    enabledPaymentMethods: JSON.parse(s.enabledPaymentMethods),
    kitchenPrepWarnMin: s.kitchenPrepWarnMin,
    kitchenPrepUrgentMin: s.kitchenPrepUrgentMin,
    kitchenPickupUrgentMin: s.kitchenPickupUrgentMin,
    deliveryFee: s.deliveryFee,
    restaurantLat: s.restaurantLat,
    restaurantLong: s.restaurantLong,
    freeDeliveryMin: s.freeDeliveryMin,
    deliveryFeeTiers: JSON.parse(s.deliveryFeeTiers),
    deliveryPrepMinutes: s.deliveryPrepMinutes,
    minutesPerKm: s.minutesPerKm,
  };
}

export async function getStoreSettingsUsecase(storeId: string) {
  const key = `store-settings:${storeId}`;
  const cached = cache.get<ReturnType<typeof serialize>>(key);
  if (cached) return cached;
  const s = await db.query.storeSettings.findFirst({ where: eq(storeSettings.storeId, storeId) });
  if (!s) throw Errors.notFound("Configuração da loja");
  const result = serialize(s);
  cache.set(key, result, { ttl: 300 });
  return result;
}

export async function updateStoreSettingsUsecase(storeId: string, input: {
  merchantName: string;
  merchantCity: string;
  brandColor: string;
  pixKey: string;
  pixKeyType: "cpf" | "cnpj" | "email" | "phone" | "random";
  usesTables: boolean;
  kitchenEnabled: boolean;
  usesDelivery: boolean;
  ifoodIntegrationEnabled: boolean;
  // Opcional de propósito: um client antigo (sem o campo no body) não pode
  // apagar a flag — ver o fallback para `current` na gravação.
  whatsappIntegrationEnabled?: boolean;
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
}) {
  if (input.merchantName.length > 25) throw Errors.validationFailed({ field: "merchantName", max: 25 });
  if (input.merchantCity.length > 15) throw Errors.validationFailed({ field: "merchantCity", max: 15 });
  if (!/^#[0-9a-fA-F]{6}$/.test(input.brandColor)) throw Errors.validationFailed({ field: "brandColor" });
  if (input.kitchenPrepUrgentMin <= input.kitchenPrepWarnMin) throw Errors.invalidKitchenThresholds();

  const current = await db.query.storeSettings.findFirst({ where: eq(storeSettings.storeId, storeId) });
  if (!current) throw Errors.notFound("Configuração da loja");

  const nameOrCityChanged = input.merchantName !== current.merchantName || input.merchantCity !== current.merchantCity;

  // A chave Pix entra canônica no banco (telefone em E.164, documento só
  // dígitos, e-mail em minúsculas). Quem decide o formato é o `pixKeyType` que
  // o gerente salvou, e não a dedução por formato: 11 dígitos são CPF e celular
  // ao mesmo tempo, e chutar "CPF" punha o telefone do gerente sem DDI no QR.
  // O client repete a mesma regra na hora de gerar (`domain/pix-key.ts`).
  const pixKey = canonicalizePixKey(input.pixKey, input.pixKeyType);

  const [updated] = await db
    .update(storeSettings)
    .set({
      merchantName: input.merchantName,
      merchantCity: input.merchantCity,
      brandColor: input.brandColor,
      pixKey,
      pixKeyType: input.pixKeyType,
      usesTables: input.usesTables,
      kitchenEnabled: input.kitchenEnabled,
      usesDelivery: input.usesDelivery,
      ifoodIntegrationEnabled: input.ifoodIntegrationEnabled,
      whatsappIntegrationEnabled: input.whatsappIntegrationEnabled ?? current.whatsappIntegrationEnabled,
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
    .where(eq(storeSettings.storeId, storeId))
    .returning();

  invalidateStoreSettingsRelated(storeId);

  if (nameOrCityChanged) {
    const geocodingService = new NominatimGeocodingService();
    try {
      const coords = await geocodingService.forwardGeocode(`${input.merchantName}, ${input.merchantCity}`);
      await db.transaction(async (tx) => {
        await tx
          .update(storeSettings)
          .set({ restaurantLat: coords.latitude, restaurantLong: coords.longitude })
          .where(eq(storeSettings.storeId, storeId));
        await logAction(tx, "system", "restaurant_geocoded", null, { latitude: coords.latitude, longitude: coords.longitude });
      });
      invalidateStoreSettingsRelated(storeId);
      updated.restaurantLat = coords.latitude;
      updated.restaurantLong = coords.longitude;
    } catch (err) {
      // Geocoding failure não invalida o save — apenas registra.
    }
  }

  return serialize(updated);
}

// ---------- Logo (identidade) — upload em disco, caminho em store_settings.logo_path ----------

function uploadsDir(): string {
  const dir = path.resolve(config.uploadsDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logoFileFor(s: { logoPath: string | null }): string | null {
  if (!s.logoPath) return null;
  // O banco guarda só o nome do arquivo ("logo.<ext>"), sempre gerado por nós.
  // basename defende contra qualquer path absoluto/relativo que escape do dir.
  const filename = path.basename(s.logoPath);
  if (!filename) return null;
  return path.resolve(uploadsDir(), filename);
}

function removeFile(fullPath: string | null) {
  if (!fullPath) return;
  try {
    fs.unlinkSync(fullPath);
  } catch {
    // arquivo já removido ou inexistente — logo órfão não impede nada
  }
}

export async function saveStoreLogoUsecase(storeId: string, input: { buffer: Buffer; ext: string }, actorId: string) {
  const settings = await db.query.storeSettings.findFirst({
    where: eq(storeSettings.storeId, storeId),
  });
  if (!settings) throw Errors.notFound("Configuração da loja");

  const filename = `logo.${input.ext}`;
  const target = path.resolve(uploadsDir(), filename);
  if (!target.startsWith(uploadsDir())) {
    throw Errors.validationFailed({ field: "logo" });
  }
  fs.writeFileSync(target, input.buffer);

  // Remove o logo antigo quando a extensão muda (logo.jpg → logo.png)
  const previous = logoFileFor(settings);
  if (previous && previous !== target) removeFile(previous);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(storeSettings)
      .set({ logoPath: filename })
      .where(eq(storeSettings.storeId, storeId))
      .returning();
    await logAction(tx, actorId, "store_logo_changed", null, { logoPath: filename });
    return row;
  });
  invalidateStoreSettingsRelated(storeId);
  return serialize(updated);
}

export async function clearStoreLogoUsecase(storeId: string, actorId: string) {
  const settings = await db.query.storeSettings.findFirst({
    where: eq(storeSettings.storeId, storeId),
  });
  if (!settings) throw Errors.notFound("Configuração da loja");
  if (!settings.logoPath) return serialize(settings);

  removeFile(logoFileFor(settings));
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(storeSettings)
      .set({ logoPath: null })
      .where(eq(storeSettings.storeId, storeId))
      .returning();
    await logAction(tx, actorId, "store_logo_removed", null);
    return row;
  });
  invalidateStoreSettingsRelated(storeId);
  return serialize(updated);
}

/**
 * Helpers puros do módulo de configurações da loja: URL do logo, nomes de
 * arquivo seguros e serialização do singleton.
 *
 * `logoUrlOf`/`isSafeFilename`/`storageFilename` são funções PURAS (eram de
 * `infra/storage`, sem I/O). Mantêm a MESMA lógica.
 */
import type { StoreSettingsRow } from "../../ports/repositories.js";

/** `/uploads/logo/<filename>` — mesmo formato de `storageAssetPath`. */
const UPLOADS_PREFIX = "/uploads";
export function logoUrlOf(filename: string | null | undefined): string | null {
  return filename ? `${UPLOADS_PREFIX}/logo/${filename}` : null;
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
export function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  return FILENAME_RE.test(filename);
}

/** Normaliza o que está no banco para o nome de arquivo (só o basename). */
export function storageFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
}

export function serializeStoreSettings(s: StoreSettingsRow) {
  return {
    merchantName: s.merchantName,
    merchantCity: s.merchantCity,
    logoUrl: s.logoPath ? logoUrlOf(s.logoPath) : null,
    brandColor: s.brandColor,
    pixKey: s.pixKey,
    pixKeyType: s.pixKeyType,
    usesTables: s.usesTables,
    kitchenEnabled: s.kitchenEnabled,
    usesDelivery: s.usesDelivery,
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

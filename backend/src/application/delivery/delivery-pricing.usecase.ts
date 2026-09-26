import { db } from "../../infra/db/client.js";
import { storeSettings } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { round2 } from "../../domain/money.js";

export interface DeliveryFeeTier {
  maxKm: number;
  fee: number;
}

export interface DeliveryPricingInput {
  distanceKm: number;
  itemsTotal: number;
}

export interface DeliveryPricingResult {
  fee: number;
  isFree: boolean;
  outOfRange: boolean;
}

const DEFAULT_TIERS: DeliveryFeeTier[] = [
  { maxKm: 3, fee: 5.0 },
  { maxKm: 5, fee: 8.0 },
  { maxKm: 8, fee: 12.0 },
  { maxKm: 12, fee: 18.0 },
];

export function parseTiers(raw: string | null | undefined): DeliveryFeeTier[] {
  if (!raw) return DEFAULT_TIERS;
  try {
    const parsed = JSON.parse(raw) as DeliveryFeeTier[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TIERS;
    return parsed;
  } catch {
    return DEFAULT_TIERS;
  }
}

export function calculateDeliveryFee(tiers: DeliveryFeeTier[], distanceKm: number): number | null {
  for (const tier of tiers) {
    if (distanceKm <= tier.maxKm) {
      return tier.fee;
    }
  }
  return null;
}

export async function getDeliveryPricingUsecase(): Promise<{
  tiers: DeliveryFeeTier[];
  freeDeliveryMin: number;
}> {
  const settings = await db.query.storeSettings.findFirst();
  if (!settings) throw new Error("store_settings não inicializado");

  return {
    tiers: parseTiers(settings.deliveryFeeTiers),
    freeDeliveryMin: settings.freeDeliveryMin ?? 0,
  };
}

export function applyDeliveryPricing(
  tiers: DeliveryFeeTier[],
  freeDeliveryMin: number,
  input: DeliveryPricingInput
): DeliveryPricingResult {
  const fee = calculateDeliveryFee(tiers, input.distanceKm);
  if (fee === null) {
    return { fee: 0, isFree: false, outOfRange: true };
  }

  if (freeDeliveryMin > 0 && input.itemsTotal >= freeDeliveryMin) {
    return { fee: 0, isFree: true, outOfRange: false };
  }

  return { fee: round2(fee), isFree: false, outOfRange: false };
}

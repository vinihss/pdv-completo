// Precificação de entrega — ONDA 3 da refatoração arquitetural.
//
// As funções PURAS (`parseTiers`, `calculateDeliveryFee`, `applyDeliveryPricing`
// e `deliveryPricingFrom`) não conhecem banco nem efeitos e seguem exportadas
// como sempre — são elas que os testes e o checkout self-service
// (`order-intake.usecase.ts`) consomem. A leitura de `store_settings` virou o
// use case `getDeliveryPricingUsecase(deps)`, que fala o effect port
// `StoreSettingsReader` (mesmo caminho de `order.usecases`) dentro de um
// `uow.run`.
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): a leitura de `store_settings` que
// antes rodava "fora do tx" (`db.query.storeSettings`) passa a rodar DENTRO do
// `uow.run`. Sob READ COMMITTED o resultado é o mesmo (snapshot por statement);
// o ganho é um caminho só para ler e escrever, sem meio-commit.
import { round2 } from "../../domain/money.js";
import type { StoreSettingsReader } from "../ports/effects.js";
import type { StoreSettingsRecord } from "../ports/effects.js";
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";

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

export interface DeliveryPricingDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  settings: StoreSettingsReader;
}

/**
 * Faixas + mínimo de frete grátis a partir da linha de `store_settings` JÁ
 * lida. Pura de propósito: `calcularEntregaUsecase` roda dentro do próprio
 * `uow.run` e resolve a precificação com o settings que já tem em mãos, sem
 * abrir uma segunda transação só para reler o singleton.
 */
export function deliveryPricingFrom(
  settings: Pick<StoreSettingsRecord, "deliveryFeeTiers" | "freeDeliveryMin">,
): { tiers: DeliveryFeeTier[]; freeDeliveryMin: number } {
  return {
    tiers: parseTiers(settings.deliveryFeeTiers),
    freeDeliveryMin: settings.freeDeliveryMin ?? 0,
  };
}

/** Faixas de frete da loja (leitura do singleton dentro do `uow.run`). */
export async function getDeliveryPricingUsecase(deps: DeliveryPricingDeps): Promise<{
  tiers: DeliveryFeeTier[];
  freeDeliveryMin: number;
}> {
  return deps.uow.run(deps.tenant(), async () => deliveryPricingFrom(await deps.settings.get()));
}

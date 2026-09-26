import { describe, expect, it } from "vitest";
import {
  calculateDeliveryFee,
  applyDeliveryPricing,
  parseTiers,
  type DeliveryFeeTier,
} from "../src/application/delivery/delivery-pricing.usecase.js";

const DEFAULT_TIERS: DeliveryFeeTier[] = [
  { maxKm: 3, fee: 5.0 },
  { maxKm: 5, fee: 8.0 },
  { maxKm: 8, fee: 12.0 },
  { maxKm: 12, fee: 18.0 },
];

describe("calculateDeliveryFee", () => {
  it("retorna R$ 5,00 para distância até 3km", () => {
    expect(calculateDeliveryFee(DEFAULT_TIERS, 0)).toBe(5.0);
    expect(calculateDeliveryFee(DEFAULT_TIERS, 1.5)).toBe(5.0);
    expect(calculateDeliveryFee(DEFAULT_TIERS, 3)).toBe(5.0);
  });

  it("retorna R$ 8,00 para distância > 3km e até 5km", () => {
    expect(calculateDeliveryFee(DEFAULT_TIERS, 3.1)).toBe(8.0);
    expect(calculateDeliveryFee(DEFAULT_TIERS, 5)).toBe(8.0);
  });

  it("retorna R$ 12,00 para distância > 5km e até 8km", () => {
    expect(calculateDeliveryFee(DEFAULT_TIERS, 5.1)).toBe(12.0);
    expect(calculateDeliveryFee(DEFAULT_TIERS, 8)).toBe(12.0);
  });

  it("retorna R$ 18,00 para distância > 8km e até 12km", () => {
    expect(calculateDeliveryFee(DEFAULT_TIERS, 8.1)).toBe(18.0);
    expect(calculateDeliveryFee(DEFAULT_TIERS, 12)).toBe(18.0);
  });

  it("retorna null para distância acima de 12km (fora da área)", () => {
    expect(calculateDeliveryFee(DEFAULT_TIERS, 12.1)).toBeNull();
    expect(calculateDeliveryFee(DEFAULT_TIERS, 50)).toBeNull();
  });
});

describe("applyDeliveryPricing", () => {
  it("aplica frete normal quando total < freeDeliveryMin", () => {
    const result = applyDeliveryPricing(DEFAULT_TIERS, 50, { distanceKm: 4, itemsTotal: 30 });
    expect(result.fee).toBe(8.0);
    expect(result.isFree).toBe(false);
    expect(result.outOfRange).toBe(false);
  });

  it("aplica frete grátis quando total >= freeDeliveryMin", () => {
    const result = applyDeliveryPricing(DEFAULT_TIERS, 50, { distanceKm: 4, itemsTotal: 50 });
    expect(result.fee).toBe(0);
    expect(result.isFree).toBe(true);
    expect(result.outOfRange).toBe(false);
  });

  it("aplica frete grátis quando total > freeDeliveryMin", () => {
    const result = applyDeliveryPricing(DEFAULT_TIERS, 50, { distanceKm: 4, itemsTotal: 75 });
    expect(result.fee).toBe(0);
    expect(result.isFree).toBe(true);
  });

  it("retorna outOfRange quando distância > máxima da tabela", () => {
    const result = applyDeliveryPricing(DEFAULT_TIERS, 50, { distanceKm: 15, itemsTotal: 30 });
    expect(result.outOfRange).toBe(true);
    expect(result.fee).toBe(0);
  });

  it("freeDeliveryMin = 0 desativa frete grátis", () => {
    const result = applyDeliveryPricing(DEFAULT_TIERS, 0, { distanceKm: 4, itemsTotal: 100 });
    expect(result.fee).toBe(8.0);
    expect(result.isFree).toBe(false);
  });

  it("frete grátis não se aplica quando fora da área", () => {
    const result = applyDeliveryPricing(DEFAULT_TIERS, 50, { distanceKm: 15, itemsTotal: 100 });
    expect(result.outOfRange).toBe(true);
    expect(result.fee).toBe(0);
    expect(result.isFree).toBe(false);
  });
});

describe("parseTiers", () => {
  it("retorna default quando null", () => {
    expect(parseTiers(null)).toEqual(DEFAULT_TIERS);
  });

  it("retorna default quando string vazia", () => {
    expect(parseTiers("")).toEqual(DEFAULT_TIERS);
  });

  it("retorna default quando JSON inválido", () => {
    expect(parseTiers("not json")).toEqual(DEFAULT_TIERS);
  });

  it("retorna default quando array vazio", () => {
    expect(parseTiers("[]")).toEqual(DEFAULT_TIERS);
  });

  it("retorna default quando não é array", () => {
    expect(parseTiers('{"maxKm": 3}')).toEqual(DEFAULT_TIERS);
  });

  it("retorna tiers customizadas quando válido", () => {
    const custom = [{ maxKm: 10, fee: 20.0 }];
    expect(parseTiers(JSON.stringify(custom))).toEqual(custom);
  });
});

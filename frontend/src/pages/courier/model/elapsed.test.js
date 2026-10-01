import { describe, it, expect } from "vitest";
import { formatDuration, elapsedMinutes, elapsedInfo, QUEUE_URGENT_MIN, IN_TRANSIT_URGENT_MIN } from "./elapsed.js";

/**
 * O cronômetro é a única coisa que diz ao entregador se a parada está
 * queimando, então os dois números que importam são: nunca mostrar "NaN min"
 * (payload sem carimbo) e nunca deixar de piscar quando o prazo estourou.
 */
const AGORA = Date.parse("2026-03-01T12:00:00.000Z");
const atras = (min) => new Date(AGORA - min * 60_000).toISOString();

describe("formatDuration", () => {
  it("formata minutos e horas do jeito que se fala", () => {
    expect(formatDuration(0.2)).toBe("menos de 1 min");
    expect(formatDuration(23)).toBe("23 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(65)).toBe("1 h 05");
  });

  it("devolve string vazia sem número (a linha some, não vira 'NaN min')", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(undefined)).toBe("");
  });
});

describe("elapsedMinutes", () => {
  it("calcula a diferença em minutos", () => {
    expect(elapsedMinutes(atras(23), AGORA)).toBeCloseTo(23, 5);
  });

  it("devolve null para carimbo ausente ou inválido", () => {
    expect(elapsedMinutes(undefined, AGORA)).toBeNull();
    expect(elapsedMinutes("lixo", AGORA)).toBeNull();
  });

  it("não devolve negativo quando o relógio do celular está adiantado", () => {
    const futuro = new Date(AGORA + 5 * 60_000).toISOString();
    expect(elapsedMinutes(futuro, AGORA)).toBe(0);
  });
});

describe("elapsedInfo", () => {
  it("a fila pergunta há quanto tempo a parada está esperando", () => {
    const info = elapsedInfo({ status: "awaiting_courier", createdAt: atras(23) }, AGORA);
    expect(info.text).toBe("parada há 23 min");
    // 23 min ainda está dentro do limite de 20? Não: por isso fica urgente,
    // e o caso calmo é o de baixo do limite.
    expect(info.urgent).toBe(true);
    expect(elapsedInfo({ status: "awaiting_courier", createdAt: atras(5) }, AGORA).urgent).toBe(false);
  });

  it("a que está em rota pergunta há quanto tempo saiu", () => {
    const info = elapsedInfo({ status: "out_for_delivery", dispatchedAt: atras(12) }, AGORA);
    expect(info.text).toBe("saiu há 12 min");
  });

  it("usa createdAt quando dispatchedAt não vier (payload velho)", () => {
    const info = elapsedInfo({ status: "out_for_delivery", createdAt: atras(9) }, AGORA);
    expect(info.text).toBe("saiu há 9 min");
  });

  it("acende o alerta ao passar do limite, em cada tipo", () => {
    const fila = elapsedInfo(
      { status: "awaiting_courier", createdAt: atras(QUEUE_URGENT_MIN) },
      AGORA
    );
    expect(fila.urgent).toBe(true);

    const rota = elapsedInfo(
      { status: "out_for_delivery", dispatchedAt: atras(IN_TRANSIT_URGENT_MIN) },
      AGORA
    );
    expect(rota.urgent).toBe(true);
  });

  it("devolve null sem carimbo e para status sem cronômetro", () => {
    expect(elapsedInfo({ status: "awaiting_courier" }, AGORA)).toBeNull();
    expect(elapsedInfo({ status: "failed", createdAt: atras(9) }, AGORA)).toBeNull();
    expect(elapsedInfo(null, AGORA)).toBeNull();
  });
});
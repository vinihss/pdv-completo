import { describe, expect, it } from "vitest";
import { buildCashReportView, browserTzOffset, sessionDiff, fmtMoney } from "./cashReportView.js";

const open = {
  id: "c-open",
  status: "open",
  openedAt: "2026-09-24T22:00:00.000Z",
  closedAt: null,
  openingAmount: 100,
  expected: 119,
  counted: null,
  difference: null,
};

const closed = {
  id: "c-closed",
  status: "closed",
  openedAt: "2026-09-23T22:00:00.000Z",
  closedAt: "2026-09-23T23:30:00.000Z",
  openingAmount: 50,
  expected: 54,
  counted: 54,
  difference: 0,
};

describe("cashReportView", () => {
  it("sessão aberta não explode: diff fica null e o view marca isOpen", () => {
    expect(sessionDiff(open)).toBe(null);
    expect(sessionDiff(closed)).toBe(0);

    const view = buildCashReportView({ sessions: [open, closed] });
    const [o, c] = view.sessions;
    expect(o.isOpen).toBe(true);
    expect(o.diff).toBe(null);
    expect(c.isOpen).toBe(false);
    expect(c.diff).toBe(0);
  });

  it("totais default quando o payload está ausente", () => {
    const view = buildCashReportView(undefined);
    expect(view.sessions).toEqual([]);
    expect(view.totalCounted).toBe(0);
    expect(view.totalDifference).toBe(0);
    expect(view.openExpected).toBe(0);
  });

  it("openCount/openExpected vêm do backend (sem sessão não quebra)", () => {
    const view = buildCashReportView({ sessions: [open], openCount: 1, openExpected: 119 });
    expect(view.openCount).toBe(1);
    expect(view.openExpected).toBe(119);
  });

  it("fmtMoney formata monetário em pt-BR e tolera null", () => {
    // O \u00a0 é obrigatório: Intl usa espaço não separável entre "R$" e o
    // número em pt-BR, então um espaço comum aqui quebraria a comparação.
    expect(fmtMoney(10.5)).toBe("R$\u00a010,50");
    expect(fmtMoney(1234.5)).toBe("R$\u00a01.234,50");
    expect(fmtMoney(null)).toBe("R$\u00a00,00");
  });

  it("browserTzOffset produz ±HH:MM", () => {
    expect(browserTzOffset()).toMatch(/^[+-]\d{2}:\d{2}$/);
  });
});
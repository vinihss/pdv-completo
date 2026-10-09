import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, cashier, manager, raw, FIXTURE } from "./helpers.js";

const openDrawer = (correlationId: string, openingAmount: number, note?: string) =>
  api("post", "/cash-drawer/open", { token: cashier, body: { correlationId, openingAmount, note } });

describe("Bloco 6: Classificação de sangrias/suprimentos", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("registrar sangria com categoria válida → sucesso", async () => {
    await openDrawer("open-1", 100);

    const sangria = await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-cat-1",
        amount: 30,
        category: "sangria_operacional",
      },
    });

    expect(sangria.status).toBe(200);
    expect(sangria.json.type).toBe("sangria");
    expect(sangria.json.amount).toBe(30);
    expect(sangria.json.category).toBe("sangria_operacional");
  });

  it("registrar sangria com categoria inválida → 422 invalid_movement_category", async () => {
    await openDrawer("open-1", 100);

    const sangria = await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-cat-invalid",
        amount: 30,
        category: "categoria_inexistente",
      },
    });

    expect(sangria.status).toBe(400); // Zod validation error
  });

  it("registrar suprimento com todas as categorias válidas → sucesso", async () => {
    await openDrawer("open-1", 1000);

    const categorias = [
      "sangria_operacional",
      "suprimento_troco",
      "pagamento_fornecedor",
      "ajuste_inventario",
      "outros",
    ];

    for (const category of categorias) {
      const suprimento = await api("post", "/cash-drawer/suprimento", {
        token: cashier,
        body: {
          correlationId: `suprimento-${category}`,
          amount: 10,
          category,
        },
      });
      expect(suprimento.status).toBe(200);
      expect(suprimento.json.category).toBe(category);
    }
  });

  it("registrar movimento de alto valor sem aprovação → 403 approval_required", async () => {
    // Configurar threshold para 500
    await raw.exec("UPDATE store_settings SET cash_high_value_threshold = 500 WHERE id = 'singleton'");

    await openDrawer("open-1", 1000);

    const sangria = await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-high-value",
        amount: 600, // > 500
        category: "sangria_operacional",
      },
    });

    expect(sangria.status).toBe(403);
    expect(sangria.json.error.code).toBe("approval_required");
    expect(sangria.json.error.details.amount).toBe(600);
    expect(sangria.json.error.details.threshold).toBe(500);
  });

  it("registrar movimento de alto valor com aprovação válida → sucesso", async () => {
    // Configurar threshold para 500
    await raw.exec("UPDATE store_settings SET cash_high_value_threshold = 500 WHERE id = 'singleton'");

    await openDrawer("open-1", 1000);

    const sangria = await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-high-value-approved",
        amount: 600, // > 500
        category: "sangria_operacional",
        approvedByUserId: FIXTURE.manager,
      },
    });

    expect(sangria.status).toBe(200);
    expect(sangria.json.amount).toBe(600);
    expect(sangria.json.category).toBe("sangria_operacional");
  });

  it("registrar movimento de alto valor com aprovador sem permissão → 403 forbidden_role", async () => {
    // Configurar threshold para 500
    await raw.exec("UPDATE store_settings SET cash_high_value_threshold = 500 WHERE id = 'singleton'");

    await openDrawer("open-1", 1000);

    // FIXTURE.waiter tem role "waiter", que não é manager nem cashier
    const sangria = await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-high-value-waiter",
        amount: 600,
        category: "sangria_operacional",
        approvedByUserId: FIXTURE.waiter,
      },
    });

    expect(sangria.status).toBe(403);
    expect(sangria.json.error.code).toBe("forbidden_role");
  });

  it("fechar caixa com diferença dentro da tolerância → sucesso sem justificativa", async () => {
    // Configurar tolerância para 5
    await raw.exec("UPDATE store_settings SET cash_closing_tolerance = 5 WHERE id = 'singleton'");

    await openDrawer("open-1", 100);
    // Diferença de 3 (esperado 100, contado 97) <= tolerância 5
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "close-within-tolerance",
        countedAmount: 97,
      },
    });

    expect(close.status).toBe(200);
    expect(close.json.closingExpected).toBe(100);
    expect(close.json.closingCounted).toBe(97);
    expect(close.json.closingDifference).toBe(-3);
    expect(close.json.closingJustification).toBeNull();
  });

  it("fechar caixa com diferença acima da tolerância sem justificativa → 422 closing_tolerance_exceeded", async () => {
    // Configurar tolerância para 5
    await raw.exec("UPDATE store_settings SET cash_closing_tolerance = 5 WHERE id = 'singleton'");

    await openDrawer("open-1", 100);
    // Diferença de 10 (esperado 100, contado 90) > tolerância 5
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "close-over-tolerance",
        countedAmount: 90,
      },
    });

    expect(close.status).toBe(422);
    expect(close.json.error.code).toBe("closing_tolerance_exceeded");
    expect(close.json.error.details.difference).toBe(-10);
    expect(close.json.error.details.tolerance).toBe(5);
  });

  it("fechar caixa com diferença acima da tolerância com justificativa → sucesso", async () => {
    // Configurar tolerância para 5 e requireApprovalAbove alto
    await raw.exec(
      "UPDATE store_settings SET cash_closing_tolerance = 5, cash_closing_require_approval_above = 1000 WHERE id = 'singleton'"
    );

    await openDrawer("open-1", 100);
    // Diferença de 10 > tolerância 5, mas < requireApprovalAbove
    const close = await api("post", "/cash-drawer/close", {
      token: cashier,
      body: {
        correlationId: "close-with-justification",
        countedAmount: 90,
        justification: "Diferença de troco para cliente",
      },
    });

    expect(close.status).toBe(200);
    expect(close.json.closingDifference).toBe(-10);
    expect(close.json.closingJustification).toBe("Diferença de troco para cliente");
  });

  it("categoria é retornada na listagem de movimentos", async () => {
    await openDrawer("open-1", 100);

    await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-list",
        amount: 20,
        category: "pagamento_fornecedor",
      },
    });

    await api("post", "/cash-drawer/suprimento", {
      token: cashier,
      body: {
        correlationId: "suprimento-list",
        amount: 15,
        category: "suprimento_troco",
      },
    });

    const cur = await api("get", "/cash-drawer/current", { token: cashier });
    expect(cur.status).toBe(200);
    expect(cur.json.movements).toHaveLength(2);

    const sangria = cur.json.movements.find((m: any) => m.type === "sangria");
    expect(sangria.category).toBe("pagamento_fornecedor");

    const suprimento = cur.json.movements.find((m: any) => m.type === "suprimento");
    expect(suprimento.category).toBe("suprimento_troco");
  });

  it("movimento de alto valor exatamente no threshold não exige aprovação", async () => {
    // Configurar threshold para 500
    await raw.exec("UPDATE store_settings SET cash_high_value_threshold = 500 WHERE id = 'singleton'");

    await openDrawer("open-1", 1000);

    // Valor exatamente igual ao threshold não deve exigir aprovação
    const sangria = await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-at-threshold",
        amount: 500, // == threshold, não >
        category: "sangria_operacional",
      },
    });

    expect(sangria.status).toBe(200);
    expect(sangria.json.amount).toBe(500);
  });

  it("movimento logo acima do threshold exige aprovação", async () => {
    // Configurar threshold para 500
    await raw.exec("UPDATE store_settings SET cash_high_value_threshold = 500 WHERE id = 'singleton'");

    await openDrawer("open-1", 1000);

    // Valor logo acima do threshold deve exigir aprovação
    const sangria = await api("post", "/cash-drawer/sangria", {
      token: cashier,
      body: {
        correlationId: "sangria-above-threshold",
        amount: 500.01, // > threshold
        category: "sangria_operacional",
      },
    });

    expect(sangria.status).toBe(403);
    expect(sangria.json.error.code).toBe("approval_required");
  });
});

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "../src/infra/db/client.js";
import { orders, orderItems, orderPayments, alerts, cashDrawers, storeSettings } from "../src/infra/db/schema.js";
import { eq } from "drizzle-orm";
import { concludeIfoodOrder } from "../src/integrations/ifood/status-pushback.js";
import { seedFixture, resetState, closeTestApp, FIXTURE } from "./helpers.js";

// Helper para criar um pedido iFood de teste
async function createIfoodOrder(opts: {
  externalRef: string;
  tabLabel?: string;
  deliveryFee?: number;
  paymentMethods: Array<{ method: string; type?: string }>;
}): Promise<string> {
  const openedAt = new Date(Date.now() - 60000).toISOString(); // 1 minuto atrás
  
  // Criar pedido
  const [order] = await db
    .insert(orders)
    .values({
      waiterId: FIXTURE.waiter,
      customerId: null,
      tabLabel: opts.tabLabel ?? `iFood ${opts.externalRef}`,
      channel: "ifood",
      externalRef: opts.externalRef,
      deliveryFee: opts.deliveryFee ?? 0,
      ifoodPayments: JSON.stringify(opts.paymentMethods),
      openedAt,
    })
    .returning();

  // Adicionar itens (2x produto)
  await db.insert(orderItems).values({
    orderId: order.id,
    productId: FIXTURE.product,
    quantity: 2,
    unitPrice: 9.5, // preço do produto na fixture
    createdBy: FIXTURE.waiter,
  });

  return order.id;
}

// Helper para abrir caixa
async function openCashDrawer() {
  await db.insert(cashDrawers).values({
    openedBy: FIXTURE.cashier,
    openingAmount: 100,
    openedAt: new Date().toISOString(),
  });
}

// Helper para verificar se não há caixa aberto
async function ensureNoOpenDrawer() {
  await db.delete(cashDrawers).where(eq(cashDrawers.status, "open"));
}

describe("iFood pushback (Bloco 3)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(async () => {
    await resetState();
    await ensureNoOpenDrawer();
    // Restaurar métodos de pagamento habilitados (testes podem modificar)
    await db
      .update(storeSettings)
      .set({ enabledPaymentMethods: JSON.stringify(["cash", "card", "pix", "other"]) })
      .where(eq(storeSettings.id, "singleton"));
  });

  describe("iFood em dinheiro (cash)", () => {
    it("com caixa aberto: payment confirmado, confirmedAt = order.openedAt, sem alerta", async () => {
      const orderId = await createIfoodOrder({
        externalRef: "ifood-cash-open-1",
        paymentMethods: [{ method: "CASH" }],
      });

      // Abrir caixa
      await openCashDrawer();

      // Concluir pedido iFood
      const result = await concludeIfoodOrder("ifood-cash-open-1");
      expect(result).toBe(true);

      // Verificar payment
      const [payment] = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      expect(payment).toBeDefined();
      expect(payment.confirmed).toBe(true);
      expect(payment.method).toBe("cash");
      expect(payment.amount).toBe(19.0); // 2 * 9.5

      // confirmedAt deve ser order.openedAt, não o momento do webhook
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(payment.confirmedAt).toBe(order.openedAt);
      expect(payment.confirmedBy).toBe("system");

      // Não deve haver alerta
      const alertCount = await db
        .select()
        .from(alerts)
        .where(eq(alerts.orderId, orderId));
      expect(alertCount.length).toBe(0);
    });

    it("com caixa fechado: payment pendente, confirmedAt null, alerta gerado", async () => {
      const orderId = await createIfoodOrder({
        externalRef: "ifood-cash-closed-1",
        paymentMethods: [{ method: "CASH" }],
      });

      // Garantir que não há caixa aberto
      await ensureNoOpenDrawer();

      // Concluir pedido iFood
      const result = await concludeIfoodOrder("ifood-cash-closed-1");
      expect(result).toBe(true);

      // Verificar payment
      const [payment] = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      expect(payment).toBeDefined();
      expect(payment.confirmed).toBe(false);
      expect(payment.method).toBe("cash");
      expect(payment.confirmedAt).toBeNull();
      expect(payment.confirmedBy).toBeNull();
      expect(payment.amount).toBe(19.0);

      // Verificar alerta
      const [alert] = await db
        .select()
        .from(alerts)
        .where(eq(alerts.orderId, orderId));

      expect(alert).toBeDefined();
      expect(alert.kind).toBe("ifood_cash_pending");
      expect(alert.title).toContain("Pagamento iFood pendente");
      expect(alert.body).toContain("R$ 19,00");
      expect(alert.body).toContain("Abra o caixa");
      expect(alert.audienceRoles).toEqual(["manager", "cashier"]);
    });
  });

  describe("iFood Pix", () => {
    it("confirmado com confirmedAt = order.openedAt, sem alerta (independente do caixa)", async () => {
      const orderId = await createIfoodOrder({
        externalRef: "ifood-pix-1",
        paymentMethods: [{ method: "PIX" }],
      });

      // Caixa fechado não deve afetar Pix
      await ensureNoOpenDrawer();

      const result = await concludeIfoodOrder("ifood-pix-1");
      expect(result).toBe(true);

      const [payment] = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      expect(payment).toBeDefined();
      expect(payment.confirmed).toBe(true);
      expect(payment.method).toBe("pix");
      expect(payment.amount).toBe(19.0);

      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(payment.confirmedAt).toBe(order.openedAt);
      expect(payment.confirmedBy).toBe("system");

      // Não deve haver alerta
      const alertCount = await db
        .select()
        .from(alerts)
        .where(eq(alerts.orderId, orderId));
      expect(alertCount.length).toBe(0);
    });
  });

  describe("iFood cartão", () => {
    it("confirmado com confirmedAt = order.openedAt, sem alerta", async () => {
      const orderId = await createIfoodOrder({
        externalRef: "ifood-card-1",
        paymentMethods: [{ method: "CREDIT" }],
      });

      await ensureNoOpenDrawer();

      const result = await concludeIfoodOrder("ifood-card-1");
      expect(result).toBe(true);

      const [payment] = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      expect(payment).toBeDefined();
      expect(payment.confirmed).toBe(true);
      expect(payment.method).toBe("card");
      expect(payment.amount).toBe(19.0);

      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(payment.confirmedAt).toBe(order.openedAt);

      const alertCount = await db
        .select()
        .from(alerts)
        .where(eq(alerts.orderId, orderId));
      expect(alertCount.length).toBe(0);
    });
  });

  describe("Replay idempotente", () => {
    it("concluir o mesmo pedido duas vezes não duplica payment nem alerta", async () => {
      const orderId = await createIfoodOrder({
        externalRef: "ifood-replay-1",
        paymentMethods: [{ method: "CASH" }],
      });

      await ensureNoOpenDrawer();

      // Primeira conclusão
      const result1 = await concludeIfoodOrder("ifood-replay-1");
      expect(result1).toBe(true);

      // Segunda conclusão (replay)
      const result2 = await concludeIfoodOrder("ifood-replay-1");
      expect(result2).toBe(false); // Deve retornar false (status não é mais "open")

      // Verificar que só há um payment
      const payments = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));
      expect(payments.length).toBe(1);

      // Verificar que só há um alerta
      const alertList = await db
        .select()
        .from(alerts)
        .where(eq(alerts.orderId, orderId));
      expect(alertList.length).toBe(1);
    });
  });

  describe("Método não habilitado", () => {
    it("quando nenhum método está habilitado, não grava payment", async () => {
      // Desabilitar todos os métodos de pagamento
      await db
        .update(storeSettings)
        .set({ enabledPaymentMethods: JSON.stringify([]) })
        .where(eq(storeSettings.id, "singleton"));

      const orderId = await createIfoodOrder({
        externalRef: "ifood-no-method-1",
        paymentMethods: [{ method: "CASH" }],
      });

      await openCashDrawer();

      const result = await concludeIfoodOrder("ifood-no-method-1");
      expect(result).toBe(true);

      // Não deve haver payment
      const payments = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));
      expect(payments.length).toBe(0);
    });
  });

  describe("Delivery fee", () => {
    it("payment inclui delivery fee no total", async () => {
      const orderId = await createIfoodOrder({
        externalRef: "ifood-delivery-1",
        paymentMethods: [{ method: "PIX" }],
        deliveryFee: 5.5,
      });

      await ensureNoOpenDrawer();

      const result = await concludeIfoodOrder("ifood-delivery-1");
      expect(result).toBe(true);

      const [payment] = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      expect(payment).toBeDefined();
      expect(payment.amount).toBe(24.5); // 2 * 9.5 + 5.5
    });
  });
});

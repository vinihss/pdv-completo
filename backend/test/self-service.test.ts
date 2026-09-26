import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, tokenOf, manager, kitchen, FIXTURE } from "./helpers.js";
import { rawSqlite } from "../src/infra/db/client.js";
import { handleIncomingWhatsAppMessage } from "../src/application/self-service/whatsapp-bot.usecases.js";
import {
  deriveCustomerStage,
  stageTimeline,
  canTransitionDelivery,
  isCustomerCancellable,
  CUSTOMER_CANCELLABLE_STAGES,
} from "../src/domain/customer-order-state.js";

const COURIER = "u-courier";
const COURIER_FIXTURE = { id: COURIER, name: "Entregador Teste", role: "courier", pin_hash: "x" };

// Modo com delivery E com cozinha: sem cozinha os itens do pedido nascem
// "delivered" (paridade de configuração, ver order.usecases.ts) e a máquina do
// cliente saltaria direto pra "ready". Os toggles são restaurados no afterAll
// porque o SQLite de teste é compartilhado entre arquivos.
function enableDelivery() {
  rawSqlite.exec(`
    UPDATE store_settings SET uses_delivery = 1, kitchen_enabled = 1, delivery_fee = 5 WHERE id = 'singleton';
    INSERT OR IGNORE INTO "user" (id, name, role, pin_hash)
      VALUES ('${COURIER}', '${COURIER_FIXTURE.name}', '${COURIER_FIXTURE.role}', '${COURIER_FIXTURE.pin_hash}');
  `);
}

const courierToken = () => tokenOf(COURIER, "courier");

// outbox_event.id é UUID (PK textual) — ordem de emissão é o rowid do
// SQLite, não o id (ordenar por id seria alfabético e aleatório).
const outboxTypes = (room: string): string[] =>
  (rawSqlite
    .prepare(`SELECT event_type FROM outbox_event WHERE room = ? AND published = 0 ORDER BY rowid`)
    .all(room) as { event_type: string }[]).map((r) => r.event_type);

const outboxPayloads = (room: string, eventType: string): any[] =>
  (
    rawSqlite
      .prepare(
        `SELECT payload FROM outbox_event WHERE room = ? AND event_type = ? AND published = 0 ORDER BY rowid`
      )
      .all(room, eventType) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload));

// As rotas públicas têm rate limit por IP E por telefone (5 pedidos/min em
// POST /public/orders) — cada teste roda como um cliente distinto (IP via
// X-Forwarded-For + telefone próprio) pra não se auto-bloquear nem depender
// da ordem de execução.
let seq = 0;
const nextIp = () => `10.0.${Math.floor(seq / 250)}.${(seq % 250) + 1}`;
const nextPhone = () => `1190000${String((seq = (seq + 1) % 10000)).padStart(4, "0")}`;

async function createDeliveryOrder(phone: string, paymentMethodIntent = "cash", ip = nextIp()) {
  return api("post", "/public/orders", {
    ip,
    body: {
      correlationId: crypto.randomUUID(),
      channel: "web",
      customerPhone: phone,
      customerName: "Cliente Teste",
      newAddress: { street: "Rua A", number: "10", neighborhood: "Centro", city: "Sao Paulo" },
      items: [{ productId: FIXTURE.product, quantity: 2 }],
      paymentMethodIntent,
    },
  });
}

async function statusOf(orderId: string, ip?: string) {
  const res = await api("get", `/public/orders/${orderId}/status`, ip ? { ip } : {});
  return res.json;
}

// marca o item pronto (cozinha) e devolve o orderId + deliveryId
async function readyOrder(orderId: string) {
  const items = rawSqlite.prepare(`SELECT id, version FROM order_item WHERE order_id = ?`).all(orderId) as {
    id: string;
    version: number;
  }[];
  for (const it of items) {
    await api("patch", `/orders/${orderId}/items/${it.id}`, {
      token: kitchen,
      body: { status: "ready", expectedVersion: it.version },
    });
  }
  const delivery = rawSqlite.prepare(`SELECT id FROM delivery WHERE order_id = ?`).get(orderId) as { id: string };
  return delivery.id;
}

async function assignCourier(deliveryId: string) {
  return api("patch", `/manager/deliveries/${deliveryId}/assign`, {
    token: manager,
    body: { courierId: COURIER },
  });
}

// ---------------------------------------------------------------------------
describe("máquina de estado do cliente (puro)", () => {
  it("derivação: cancelamento e falha de entrega vencem qualquer outro eixo", () => {
    expect(deriveCustomerStage({ status: "cancelled" }, [{ status: "delivered" }], { status: "out_for_delivery" })).toBe("cancelled");
    expect(deriveCustomerStage({ status: "open" }, [{ status: "ready" }], { status: "failed" })).toBe("failed");
  });

  it("derivação: eixo da delivery tem precedência sobre o fechamento do pedido", () => {
    expect(deriveCustomerStage({ status: "open" }, [{ status: "ready" }], { status: "out_for_delivery" })).toBe("out_for_delivery");
    expect(deriveCustomerStage({ status: "open" }, [{ status: "delivered" }], { status: "delivered" })).toBe("delivered");
    expect(deriveCustomerStage({ status: "closed" }, [{ status: "delivered" }], { status: "out_for_delivery" })).toBe("out_for_delivery");
  });

  it("derivação: comanda fechada sem delivery = entregue; itens definem received/preparing/ready", () => {
    expect(deriveCustomerStage({ status: "closed" }, [{ status: "delivered" }], null)).toBe("delivered");
    expect(deriveCustomerStage({ status: "open" }, [], { status: "awaiting_courier" })).toBe("received");
    expect(deriveCustomerStage({ status: "open" }, [{ status: "ordered" }], { status: "awaiting_courier" })).toBe("received");
    expect(deriveCustomerStage({ status: "open" }, [{ status: "ordered" }, { status: "ready" }], { status: "awaiting_courier" })).toBe("preparing");
    expect(deriveCustomerStage({ status: "open" }, [{ status: "ready" }, { status: "delivered" }], { status: "awaiting_courier" })).toBe("ready");
  });

  it("itens cancelados não contam pro stage", () => {
    expect(deriveCustomerStage({ status: "open" }, [{ status: "ready" }, { status: "cancelled" }], { status: "awaiting_courier" })).toBe("ready");
    expect(deriveCustomerStage({ status: "open" }, [{ status: "cancelled" }], { status: "awaiting_courier" })).toBe("received");
  });

  it("timeline: done/current até o stage atual; terminais fora da ordem não marcam etapa", () => {
    const t = stageTimeline("ready");
    expect(t.map((e) => [e.stage, e.done, e.current])).toEqual([
      ["received", true, false],
      ["preparing", true, false],
      ["ready", false, true],
      ["out_for_delivery", false, false],
      ["delivered", false, false],
    ]);
    const failed = stageTimeline("failed");
    expect(failed.every((e) => !e.done && !e.current)).toBe(true);
  });

  it("transições de delivery: matriz da máquina (terminal não transiciona)", () => {
    expect(canTransitionDelivery("awaiting_courier", "out_for_delivery")).toBe(true);
    expect(canTransitionDelivery("awaiting_courier", "delivered")).toBe(false);
    expect(canTransitionDelivery("out_for_delivery", "delivered")).toBe(true);
    expect(canTransitionDelivery("out_for_delivery", "failed")).toBe(true);
    expect(canTransitionDelivery("out_for_delivery", "cancelled")).toBe(true);
    expect(canTransitionDelivery("delivered", "cancelled")).toBe(false);
    expect(canTransitionDelivery("cancelled", "out_for_delivery")).toBe(false);
    expect(canTransitionDelivery("failed", "cancelled")).toBe(true);
    expect(canTransitionDelivery("failed", "delivered")).toBe(false);
  });

  it("cancelamento do cliente: só antes de sair em rota (ou entrega falha)", () => {
    expect(CUSTOMER_CANCELLABLE_STAGES).toEqual(["received", "preparing", "ready", "failed"]);
    expect(isCustomerCancellable("out_for_delivery")).toBe(false);
    expect(isCustomerCancellable("failed")).toBe(true);
    expect(isCustomerCancellable("delivered")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("self-service: stage público, cancelamento e continuação", () => {
  beforeAll(() => {
    seedFixture();
    enableDelivery();
  });
  afterAll(async () => {
    rawSqlite.exec(`
      UPDATE store_settings SET uses_delivery = 1, kitchen_enabled = 1, delivery_fee = 0 WHERE id = 'singleton';
      DELETE FROM "user" WHERE id = '${COURIER}';
    `);
    await closeTestApp();
  });
  beforeEach(() => resetState());

  it("criação → stage 'received' e evento público no room order:<id>", async () => {
    const ip = nextIp();
    const created = await createDeliveryOrder(nextPhone(), "cash", ip);
    expect(created.status).toBe(201);
    const orderId = created.json.orderId;

    const s = await statusOf(orderId, ip);
    expect(s.orderStatus).toBe("open");
    expect(s.deliveryStatus).toBe("awaiting_courier");
    expect(s.customerStage).toEqual({ stage: "received", label: "Pedido recebido", terminal: false });
    expect(s.timeline[0]).toMatchObject({ stage: "received", current: true });
    expect(s.total).toBe(24); // 2 × 9,50 + taxa 5

    const events = outboxPayloads(`order:${orderId}`, "customer.stage_changed");
    expect(events.at(-1)).toMatchObject({ stage: "received" });
  });

  it("itens prontos → stage 'ready' (derivado, sem coluna própria)", async () => {
    const ip = nextIp();
    const created = await createDeliveryOrder(nextPhone(), "cash", ip);
    const orderId = created.json.orderId;
    await readyOrder(orderId);

    const s = await statusOf(orderId, ip);
    expect(s.itemsStatus.every((i: any) => i.status === "ready")).toBe(true);
    expect(s.customerStage.stage).toBe("ready");
    // a transição received → ready emite evento pro room público (a contagem
    // exata não é o contrato; o que importa é o último stage publicado)
    const stages = outboxPayloads(`order:${orderId}`, "customer.stage_changed").map((e) => e.stage);
    expect(stages[0]).toBe("received");
    expect(stages.at(-1)).toBe("ready");
  });

  it("assign → dispatch → out_for_delivery bloqueia cancelamento do cliente", async () => {
    const ip = nextIp();
    const phone = nextPhone();
    const created = await createDeliveryOrder(phone, "cash", ip);
    const orderId = created.json.orderId;
    const deliveryId = await readyOrder(orderId);
    await assignCourier(deliveryId);
    const dispatch = await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courierToken() });
    expect(dispatch.status).toBe(200);

    expect((await statusOf(orderId, ip)).customerStage.stage).toBe("out_for_delivery");

    const cancel = await api("post", `/public/orders/${orderId}/cancel`, {
      ip,
      body: { correlationId: crypto.randomUUID(), customerPhone: phone },
    });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error.code).toBe("invalid_transition");
    // pedido continua aberto
    expect((await statusOf(orderId, ip)).orderStatus).toBe("open");
  });

  it("dispatch → deliver → 'delivered' terminal e fecha a comanda", async () => {
    // cartão: o caminho de dinheiro exige caixa aberto (hard block do caixa),
    // o que é coberto pela suíte de cash-flow — aqui o alvo é o stage.
    const ip = nextIp();
    const created = await createDeliveryOrder(nextPhone(), "card", ip);
    const orderId = created.json.orderId;
    const deliveryId = await readyOrder(orderId);
    await assignCourier(deliveryId);
    await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courierToken() });
    const delivered = await api("patch", `/courier/deliveries/${deliveryId}/deliver`, { token: courierToken() });
    expect(delivered.status).toBe(200);

    const s = await statusOf(orderId, ip);
    expect(s.customerStage).toEqual({ stage: "delivered", label: "Entregue", terminal: true });
    expect(s.orderStatus).toBe("closed");
    expect(outboxTypes(`order:${orderId}`)).toContain("customer.stage_changed");
  });

  it("dispatch → fail → 'failed' permite cancelar o pedido aberto (delivery vai a cancelled)", async () => {
    const ip = nextIp();
    const phone = nextPhone();
    const created = await createDeliveryOrder(phone, "cash", ip);
    const orderId = created.json.orderId;
    const deliveryId = await readyOrder(orderId);
    await assignCourier(deliveryId);
    await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courierToken() });
    const fail = await api("patch", `/courier/deliveries/${deliveryId}/fail`, {
      token: courierToken(),
      body: { reason: "cliente ausente" },
    });
    expect(fail.status).toBe(200);
    expect((await statusOf(orderId, ip)).customerStage.stage).toBe("failed");

    const cancel = await api("post", `/public/orders/${orderId}/cancel`, {
      ip,
      body: { correlationId: crypto.randomUUID(), customerPhone: phone },
    });
    expect(cancel.status).toBe(200);
    expect(cancel.json).toEqual({ orderId, status: "cancelled" });

    const s = await statusOf(orderId, ip);
    expect(s.orderStatus).toBe("cancelled");
    expect(s.customerStage).toEqual({ stage: "cancelled", label: "Cancelado", terminal: true });
    expect(s.deliveryStatus).toBe("cancelled");
    expect(outboxPayloads(`order:${orderId}`, "customer.stage_changed").at(-1)).toMatchObject({ stage: "cancelled" });
  });

  it("cancelamento só pelo dono: telefone diferente → 403 e pedido intacto", async () => {
    const ip = nextIp();
    const phone = nextPhone();
    const created = await createDeliveryOrder(phone, "cash", ip);
    const orderId = created.json.orderId;
    const cancel = await api("post", `/public/orders/${orderId}/cancel`, {
      ip,
      body: { correlationId: crypto.randomUUID(), customerPhone: `${phone.slice(0, -1)}0` },
    });
    expect(cancel.status).toBe(403);
    expect((await statusOf(orderId, ip)).orderStatus).toBe("open");
  });

  it("cancelamento é idempotente (mesmo correlationId devolve a resposta cacheada)", async () => {
    const ip = nextIp();
    const phone = nextPhone();
    const created = await createDeliveryOrder(phone, "cash", ip);
    const orderId = created.json.orderId;
    const correlationId = crypto.randomUUID();
    const first = await api("post", `/public/orders/${orderId}/cancel`, { ip, body: { correlationId, customerPhone: phone } });
    const replay = await api("post", `/public/orders/${orderId}/cancel`, { ip, body: { correlationId, customerPhone: phone } });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    // um único cancelamento no audit
    const rows = rawSqlite
      .prepare(`SELECT COUNT(*) n FROM audit_log WHERE order_id = ? AND action = 'order_cancelled'`)
      .get(orderId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("carrinho server-side: PUT → GET → DELETE, e expirado volta vazio", async () => {
    const ip = nextIp();
    const phone = nextPhone();
    const put = await api("put", "/public/cart", {
      ip,
      body: {
        phone,
        items: [
          { productId: FIXTURE.product, quantity: 2, selectedVariations: { tamanho: "Grande" }, notes: "sem gelo" },
          { productId: FIXTURE.product, quantity: 1 },
        ],
      },
    });
    expect(put.status).toBe(200);

    const get = await api("get", `/public/cart?phone=${phone}`, { ip });
    expect(get.json.items).toHaveLength(2);
    expect(get.json.items[0]).toEqual({
      productId: FIXTURE.product,
      quantity: 2,
      selectedVariations: { tamanho: "Grande" },
      notes: "sem gelo",
    });

    // TTL: linha expirada é tratada como carrinho vazio (e não volta no GET).
    rawSqlite.exec(`UPDATE customer_cart SET expires_at = '2000-01-01T00:00:00Z' WHERE phone = '${phone}'`);
    const expired = await api("get", `/public/cart?phone=${phone}`, { ip });
    expect(expired.json.items).toEqual([]);
    const rows = rawSqlite.prepare(`SELECT COUNT(*) n FROM customer_cart WHERE phone = ?`).get(phone) as { n: number };
    expect(rows.n).toBe(0);

    // PUT sobrescreve (não acumula) e DELETE limpa
    await api("put", "/public/cart", { ip, body: { phone, items: [{ productId: FIXTURE.product, quantity: 5 }] } });
    const del = await api("delete", "/public/cart", { ip, body: { phone } });
    expect(del.status).toBe(200);
    const after = await api("get", `/public/cart?phone=${phone}`, { ip });
    expect(after.json.items).toEqual([]);
  });

  it("pedido em andamento por telefone vira banner e some ao cancelar", async () => {
    const ip = nextIp();
    const phone = nextPhone();
    const none = await api("post", "/public/orders/active", { ip, body: { phone } });
    expect(none.json).toBeNull();

    const created = await createDeliveryOrder(phone, "cash", ip);
    const orderId = created.json.orderId;

    const active = await api("post", "/public/orders/active", { ip, body: { phone } });
    expect(active.json).toMatchObject({ orderId, customerStage: { stage: "received" }, total: 24 });

    await api("post", `/public/orders/${orderId}/cancel`, {
      ip,
      body: { correlationId: crypto.randomUUID(), customerPhone: phone },
    });
    const after = await api("post", "/public/orders/active", { ip, body: { phone } });
    expect(after.json).toBeNull();
  });

  it("bot manda o link do pedido em andamento (retomada) em vez do cardápio", async () => {
    const ip = nextIp();
    const phone = nextPhone();

    const semPedido = await handleIncomingWhatsAppMessage(phone, "oi");
    expect(semPedido.replyText).toContain("cardápio");
    expect(semPedido.replyText).toContain(`phone=${phone}`);
    expect(semPedido.replyText).not.toContain("order=");

    const { orderId } = (await createDeliveryOrder(phone, "cash", ip)).json;

    const comPedido = await handleIncomingWhatsAppMessage(phone, "oi de novo");
    expect(comPedido.replyText).toContain(`order=${orderId}`);
    expect(comPedido.replyText).toContain("Pedido recebido");
    // O link de retomada é a página com via=whatsapp: a página usa phone pra
    // identificar e order pra abrir direto o acompanhamento.
    expect(comPedido.replyText).toContain("/pedido?");
    expect(comPedido.replyText).toContain("via=whatsapp");

    // Pedido cancelado deixa de aparecer como "em andamento" — o bot volta a
    // convidar pro cardápio.
    await api("post", `/public/orders/${orderId}/cancel`, {
      ip,
      body: { correlationId: crypto.randomUUID(), customerPhone: phone },
    });
    const depois = await handleIncomingWhatsAppMessage(phone, "e aí?");
    expect(depois.replyText).toContain("cardápio");
    expect(depois.replyText).not.toContain("order=");
  });
});

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, tokenOf, manager, kitchen, FIXTURE, raw } from "./helpers.js";
import { handleIncomingWhatsAppMessage } from "../src/application/self-service/whatsapp-bot.usecases.js";
import {
  deriveCustomerStage,
  stageTimeline,
  canTransitionDelivery,
  isCustomerCancellable,
  CUSTOMER_CANCELLABLE_STAGES,
} from "../src/domain/customer-order-state.js";
import {
  alertUserToken,
  alertsUserRoomFor,
  describeDeliveryAssignedAlert,
  DELIVERY_ASSIGNED_ALERT_KIND,
  ORDER_ALERT_AUDIENCE,
} from "../src/application/alert/alert.usecases.js";

const COURIER = "u-courier";
const COURIER_FIXTURE = { id: COURIER, name: "Entregador Teste", role: "courier", pin_hash: "x" };

// Modo com delivery E com cozinha: sem cozinha os itens do pedido nascem
// "delivered" (paridade de configuração, ver order.usecases.ts) e a máquina do
// cliente saltaria direto pra "ready". Os toggles são restaurados no afterAll
// porque o banco de teste é compartilhado entre arquivos.
async function enableDelivery() {
  await raw.exec(`
    UPDATE store_settings SET uses_delivery = true, kitchen_enabled = true, delivery_fee = 5 WHERE id = 'singleton';
    INSERT INTO "user" (id, name, role, pin_hash)
      VALUES ('${COURIER}', '${COURIER_FIXTURE.name}', '${COURIER_FIXTURE.role}', '${COURIER_FIXTURE.pin_hash}')
      ON CONFLICT (id) DO NOTHING;
  `);
}

const courierToken = () => tokenOf(COURIER, "courier");

// Produto com grupo de variação OBRIGATÓRIO — é o caso que o checkout
// precisa barrar (X-Burger sem "Ponto da carne" não pode virar pedido).
const VARIED_PRODUCT = "p-var";
async function seedVariedProduct() {
  await raw.exec(`
    INSERT INTO product (id, name, price, category_id, variations)
      VALUES ('${VARIED_PRODUCT}', 'X-Burger', 28, '${FIXTURE.category}',
              '[{"name":"Ponto da carne","options":["Mal passado","Ao ponto"],"required":true}]')
      ON CONFLICT (id) DO NOTHING;
  `);
}

// outbox_event.id é UUID (PK textual) — ordem de emissão é a sequência
// `seq` (bigserial), não o id (ordenar por id seria alfabético e aleatório).
// O filtro é por room/event_type, SEM `published`: o dispatcher marca
// `published = true` ao despachar, e isso é detalhe de entrega, não do contrato de
// emissão. Filtrar por pendência fazia a asserção depender de timing — o
// `stages[0]` do teste de 'ready' sumia quando um ciclo do dispatcher rodava
// entre a criação do pedido e a leitura. Como `main()` não roda no import (ver
// guard em src/http/server.ts), o outbox nos testes só cresce por enqueueEvent.
const outboxTypes = async (room: string): Promise<string[]> =>
  ((await raw.all(`SELECT event_type FROM outbox_event WHERE room = $1 ORDER BY seq`, [room])) as { event_type: string }[]).map((r) => r.event_type);

const outboxPayloads = async (room: string, eventType: string): Promise<any[]> =>
  (
    (await raw.all(
      `SELECT payload FROM outbox_event WHERE room = $1 AND event_type = $2 ORDER BY seq`,
      [room, eventType],
    )) as { payload: string }[]
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
  const items = await raw.all(`SELECT id, version FROM order_item WHERE order_id = $1`, [orderId]) as {
    id: string;
    version: number;
  }[];
  for (const it of items) {
    await api("patch", `/orders/${orderId}/items/${it.id}`, {
      token: kitchen,
      body: { status: "ready", expectedVersion: it.version },
    });
  }
  const delivery = await raw.get(`SELECT id FROM delivery WHERE order_id = $1`, [orderId]) as { id: string };
  return delivery.id;
}

async function assignCourier(deliveryId: string, courierId: string = COURIER) {
  return api("patch", `/manager/deliveries/${deliveryId}/assign`, {
    token: manager,
    body: { courierId },
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
  beforeAll(async () => {
    await seedFixture();
    await enableDelivery();
  });
  afterAll(async () => {
    await raw.exec(`
      UPDATE store_settings SET uses_delivery = true, kitchen_enabled = true, delivery_fee = 0 WHERE id = 'singleton';
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

    const events = await outboxPayloads(`order:${orderId}`, "customer.stage_changed");
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
    const stages = (await outboxPayloads(`order:${orderId}`, "customer.stage_changed")).map((e) => e.stage);
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
    expect(await outboxTypes(`order:${orderId}`)).toContain("customer.stage_changed");
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
    expect((await outboxPayloads(`order:${orderId}`, "customer.stage_changed")).at(-1)).toMatchObject({ stage: "cancelled" });
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
    const rows = await raw.get(`SELECT COUNT(*)::int n FROM audit_log WHERE order_id = $1 AND action = 'order_cancelled'`, [orderId]) as { n: number };
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
    await raw.exec(`UPDATE customer_cart SET expires_at = '2000-01-01T00:00:00Z' WHERE phone = '${phone}'`);
    const expired = await api("get", `/public/cart?phone=${phone}`, { ip });
    expect(expired.json.items).toEqual([]);
    const rows = await raw.get(`SELECT COUNT(*)::int n FROM customer_cart WHERE phone = $1`, [phone]) as { n: number };
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

  it("menu público expõe groups com required/allowMultiple (mesmo formato do garçom)", async () => {
    await seedVariedProduct();
    const res = await api("get", "/public/menu");
    expect(res.status).toBe(200);
    const product = res.json.categories
      .flatMap((c: any) => c.products)
      .find((p: any) => p.id === VARIED_PRODUCT);
    expect(product.variations).toEqual([
      { name: "Ponto da carne", options: ["Mal passado", "Ao ponto"], required: true, allowMultiple: false },
    ]);
    // produto sem variações vem com null (o modal não abre)
    const semVariacao = res.json.categories
      .flatMap((c: any) => c.products)
      .find((p: any) => p.id === FIXTURE.product);
    expect(semVariacao.variations).toBeNull();
  });

  it("menu público marca os destaques (product.featured) para a vitrine", async () => {
    await seedVariedProduct();
    const porPadrao = await api("get", "/public/menu");
    const find = (json: any, id: string) =>
      json.categories.flatMap((c: any) => c.products).find((p: any) => p.id === id);
    // Default da migration 0020: nada é destaque até o gerente marcar.
    expect(find(porPadrao.json, VARIED_PRODUCT).featured).toBe(false);
    expect(find(porPadrao.json, FIXTURE.product).featured).toBe(false);

    // Marca via API do gerente e o menu passa a anunciar.
    await raw.exec(`UPDATE product SET featured = true WHERE id = '${VARIED_PRODUCT}'`);
    const marcado = await api("get", "/public/menu");
    expect(find(marcado.json, VARIED_PRODUCT).featured).toBe(true);
    // ...e o produto continua na sua categoria: destaque é vitrine, não exclusão.
    const categoria = marcado.json.categories.find((c: any) => c.id === FIXTURE.category);
    expect(categoria.products.map((p: any) => p.id)).toContain(VARIED_PRODUCT);
  });

  it("checkout barra grupo obrigatório não escolhido com 422 e não cria nada", async () => {
    await seedVariedProduct();
    const ip = nextIp();
    const phone = nextPhone();
    const body = (items: any[]) => ({
      correlationId: crypto.randomUUID(),
      channel: "web",
      customerPhone: phone,
      customerName: "Cliente Teste",
      newAddress: { street: "Rua A", number: "10", neighborhood: "Centro", city: "Sao Paulo" },
      items,
      paymentMethodIntent: "cash",
    });

    const semOpcao = await api("post", "/public/orders", {
      ip,
      body: body([{ productId: VARIED_PRODUCT, quantity: 1 }]),
    });
    expect(semOpcao.status).toBe(422);
    expect(semOpcao.json.error).toMatchObject({ code: "variation_required" });
    expect(semOpcao.json.error.details.groups).toEqual(["Ponto da carne"]);

    // Nada foi criado — a validação roda antes de qualquer escrita.
    const written = await raw.get(`SELECT COUNT(*)::int n FROM "order" WHERE customer_id IN (SELECT id FROM customer WHERE phone = $1)`, [phone]) as { n: number };
    expect(written.n).toBe(0);

    // Opção fora do catálogo também é recusada.
    const invalida = await api("post", "/public/orders", {
      ip,
      body: body([{ productId: VARIED_PRODUCT, quantity: 1, selectedVariations: { "Ponto da carne": "Bem passado" } }]),
    });
    expect(invalida.status).toBe(422);
    expect(invalida.json.error).toMatchObject({ code: "variation_invalid" });

    // Com a opção válida, o pedido passa e a variação chega no item.
    const ok = await api("post", "/public/orders", {
      ip,
      body: body([{ productId: VARIED_PRODUCT, quantity: 1, selectedVariations: { "Ponto da carne": "Ao ponto" } }]),
    });
    expect(ok.status).toBe(201);
    const item = await raw.get(`SELECT selected_variations FROM order_item WHERE order_id = $1`, [ok.json.orderId]) as { selected_variations: string };
    expect(JSON.parse(item.selected_variations)).toEqual({ "Ponto da carne": "Ao ponto" });
  });
});

// ---------------------------------------------------------------------------
// CEP do endereço (migration 0005). A tela /pedido já o coleta e preenche via
// ViaCEP; aqui é a persistência e a validação de formato.
describe("CEP do endereço", () => {
  // Endereço completo num telefone só, para as três rotas baterem no mesmo
  // cliente e no mesmo endereço salvo.
  const ordem = (phone: string, cep?: string) => ({
    correlationId: crypto.randomUUID(),
    channel: "web",
    customerPhone: phone,
    customerName: "Cliente Teste",
    newAddress: { street: "Rua A", number: "10", neighborhood: "Centro", city: "Sao Paulo", ...(cep !== undefined ? { cep } : {}) },
    items: [{ productId: FIXTURE.product, quantity: 1 }],
    paymentMethodIntent: "cash",
  });

  const cepSalvo = async (phone: string) =>
    (await raw.all(`SELECT cep FROM customer_address WHERE customer_id IN (SELECT id FROM customer WHERE phone = $1)`, [phone]) as { cep: string | null }[])
      .map((r) => r.cep);

  it("salva o CEP e devolve no lookup", async () => {
    const phone = nextPhone();
    const ip = nextIp();
    const res = await api("post", "/public/orders", { ip, body: ordem(phone, "01310100") });
    expect(res.status).toBe(201);
    expect(await cepSalvo(phone)).toEqual(["01310100"]);

    const lookup = await api("post", "/public/customers/lookup", { ip, body: { phone } });
    expect(lookup.status).toBe(200);
    expect(lookup.json.addresses[0]).toMatchObject({ cep: "01310100" });
  });

  it("normaliza a máscara: 01310-100 salva igual a 01310100", async () => {
    const phone = nextPhone();
    const res = await api("post", "/public/orders", { ip: nextIp(), body: ordem(phone, "01310-100") });
    expect(res.status).toBe(201);
    // Sem traço no banco — a máscara é apresentação da tela.
    expect(await cepSalvo(phone)).toEqual(["01310100"]);
  });

  it("endereço sem CEP continua válido e grava null", async () => {
    const phone = nextPhone();
    const res = await api("post", "/public/orders", { ip: nextIp(), body: ordem(phone) });
    expect(res.status).toBe(201);
    expect(await cepSalvo(phone)).toEqual([null]);
  });

  it("CEP inválido dá 400 e não grava endereço", async () => {
    for (const cep of ["123", "013101000", "0131010"]) {
      const phone = nextPhone();
      const res = await api("post", "/public/orders", { ip: nextIp(), body: ordem(phone, cep) });
      expect(res.status, `CEP ${cep} deveria dar 400`).toBe(400);
      expect(res.json.error).toMatchObject({ code: "validation_failed" });
      // Nenhum endereço criado — a validação roda antes da transação.
      expect(await cepSalvo(phone)).toEqual([]);
    }
  });

  it("CEP sem nenhum dígito é tratado como não informado", async () => {
    // Mesma convenção do normalizePhone: o que não sobra depois de tirar os
    // não-dígitos é "não informado", não erro. "abc" no telefone também vira
    // null lá — divergir entre os dois seria surpresa.
    const phone = nextPhone();
    const res = await api("post", "/public/orders", { ip: nextIp(), body: ordem(phone, "abcdefgh") });
    expect(res.status).toBe(201);
    expect(await cepSalvo(phone)).toEqual([null]);
  });

  it("CEP não entra no snapshot de delivery.address", async () => {
    // Decisão: delivery.address é legível e vai para bobina de largura fixa
    // (printer/daemon/main.go) e para a tela do entregador. O CEP fica
    // estruturado na API, não empilhado no texto. Este teste trava isso — se
    // alguém incluir o CEP no formatAddress, a bobina quebra.
    const phone = nextPhone();
    const res = await api("post", "/public/orders", { ip: nextIp(), body: ordem(phone, "01310100") });
    expect(res.status).toBe(201);
    const row = await raw.get(
      `SELECT address FROM delivery WHERE order_id = $1`,
      [res.json.orderId]
    ) as { address: string };
    expect(row.address).toBe("Rua A, 10 - Centro, Sao Paulo");
    expect(row.address).not.toContain("CEP");
    expect(row.address).not.toContain("01310100");
  });

  it("rota do balcão aceita CEP e valida igual à pública", async () => {
    const phone = nextPhone();
    await api("post", "/public/orders", { ip: nextIp(), body: ordem(phone, "01310100") });
    const lookup = await api("post", "/public/customers/lookup", { ip: nextIp(), body: { phone } });
    const customerId = lookup.json.customerId;

    const criado = await api("post", `/customers/${customerId}/addresses`, {
      token: manager,
      body: { street: "Rua B", number: "20", neighborhood: "Centro", city: "Sao Paulo", cep: "05422-030" },
    });
    expect(criado.status).toBe(201);
    expect(criado.json.cep).toBe("05422030");

    const invalido = await api("post", `/customers/${customerId}/addresses`, {
      token: manager,
      body: { street: "Rua C", number: "30", neighborhood: "Centro", city: "Sao Paulo", cep: "123" },
    });
    expect(invalido.status).toBe(400);
  });

  it("ficha do cliente devolve o CEP do endereço", async () => {
    const phone = nextPhone();
    await api("post", "/public/orders", { ip: nextIp(), body: ordem(phone, "01310100") });
    const lookup = await api("post", "/public/customers/lookup", { ip: nextIp(), body: { phone } });

    const detalhe = await api("get", `/customers/${lookup.json.customerId}`, { token: manager });
    expect(detalhe.status).toBe(200);
    expect(detalhe.json.addresses[0]).toMatchObject({ cep: "01310100" });
  });
});

// ---------------------------------------------------------------------------
// Texto do alerta de atribuição (puro) — a mesma razão de `describeOrderAlert`
// estar testado sem banco: a frase é decidida uma vez e a suíte a fixa.
describe("texto do alerta de atribuição (puro)", () => {
  it("ref do pedido + endereço no corpo", () => {
    expect(
      describeDeliveryAssignedAlert({ orderId: "abcdefgh-1234", address: "Rua A, 10 - Centro, Sao Paulo" })
    ).toEqual({
      title: "Entrega atribuída a você",
      body: "#abcdefgh · Rua A, 10 - Centro, Sao Paulo",
    });
  });

  it("endereço longo é cortado em uma linha, e sem endereço fica só a ref", () => {
    const longo = "Rua das Acácias, 1234 - Jardim Botânico, Sao Paulo - referência: portão azul, ao lado da padaria";
    const cortado = describeDeliveryAssignedAlert({ orderId: "abcdefgh-1234", address: longo });
    expect(cortado.body.endsWith("…")).toBe(true);
    expect(cortado.body.length).toBeLessThan(longo.length);

    expect(describeDeliveryAssignedAlert({ orderId: "abcdefgh-1234" }).body).toBe("#abcdefgh");
    expect(describeDeliveryAssignedAlert({ orderId: "abcdefgh-1234", address: "   " }).body).toBe("#abcdefgh");
  });

  it("a audiência global de comanda NÃO ganhou o entregador", () => {
    // O sino do entregador é dirigido (audiência `user:<id>`), não por papel:
    // se `courier` entrasse em ORDER_ALERT_AUDIENCE, todo entregador ouviria
    // cada pedido que caísse, mesmo os que não são dele.
    expect([...ORDER_ALERT_AUDIENCE]).not.toContain("courier");
    expect(alertUserToken("u-1")).toBe("user:u-1");
    expect(alertsUserRoomFor("u-1")).toBe("alerts:user:u-1");
  });
});

// ---------------------------------------------------------------------------
// Fila do entregador + alerta da atribuição. As duas metades do mesmo problema:
// o entregador precisa CONTINUAR vendo a entrega depois de dar ruim nela (item
// do default de status) e precisa SER AVISADO quando o gerente atribui uma
// entrega a ele (e só a ele).
describe("fila do entregador: a falha não some e a atribuição é avisada", () => {
  const OUTRO_COURIER = "u-courier-outro";

  beforeAll(async () => {
    await seedFixture();
    await enableDelivery();
    await raw.exec(`
      INSERT INTO "user" (id, name, role, pin_hash)
        VALUES ('${OUTRO_COURIER}', 'Outro Entregador', 'courier', 'x')
        ON CONFLICT (id) DO NOTHING;
    `);
  });
  afterAll(async () => {
    // Mesmo estado que o describe anterior deixa: o arquivo inteiro termina com
    // delivery ligado (os arquivos seguintes montam o próprio cenário).
    await raw.exec(`
      UPDATE store_settings SET uses_delivery = true, kitchen_enabled = true, delivery_fee = 0 WHERE id = 'singleton';
      DELETE FROM "user" WHERE id IN ('${COURIER}', '${OUTRO_COURIER}');
    `);
    await closeTestApp();
  });
  beforeEach(() => resetState());

  // Pedido → entrega pronta → atribuída ao `courierId` indicado.
  async function entregaProntaPara(courierId: string) {
    const created = await createDeliveryOrder(nextPhone());
    const orderId = created.json.orderId;
    const deliveryId = await readyOrder(orderId);
    const assign = await assignCourier(deliveryId, courierId);
    expect(assign.status).toBe(200);
    return { orderId, deliveryId };
  }

  // ---------- item 1: o default de status ----------

  it("a entrega que o entregador marcou como falha continua na fila dele", async () => {
    const { deliveryId } = await entregaProntaPara(COURIER);
    await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courierToken() });
    const fail = await api("patch", `/courier/deliveries/${deliveryId}/fail`, {
      token: courierToken(),
      body: { reason: "cliente ausente" },
    });
    expect(fail.status).toBe(200);

    // A regressão: sem `failed` no default, isto vinha [] e o entregador não
    // via mais nem o que ele mesmo acabou de fazer.
    const list = await api("get", "/courier/deliveries", { token: courierToken() });
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({
      id: deliveryId,
      status: "failed",
      notes: "cliente ausente",
    });
  });

  it("entregue não entra no default (histórico se pede explícito)", async () => {
    const { deliveryId } = await entregaProntaPara(COURIER);
    await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courierToken() });
    await api("patch", `/courier/deliveries/${deliveryId}/deliver`, { token: courierToken() });

    const fila = await api("get", "/courier/deliveries", { token: courierToken() });
    expect(fila.json).toEqual([]);

    // O enum do zod aceita os cinco status — é o mesmo filtro, só explícito.
    const historico = await api("get", "/courier/deliveries?status=delivered,cancelled", { token: courierToken() });
    expect(historico.status).toBe(200);
    expect(historico.json.map((d: any) => d.status)).toEqual(["delivered"]);
  });

  it("?status= explícito manda no default (failed sai quando não é pedido)", async () => {
    const { deliveryId } = await entregaProntaPara(COURIER);
    await api("patch", `/courier/deliveries/${deliveryId}/dispatch`, { token: courierToken() });
    await api("patch", `/courier/deliveries/${deliveryId}/fail`, {
      token: courierToken(),
      body: { reason: "cliente ausente" },
    });

    const soAbertas = await api("get", "/courier/deliveries?status=awaiting_courier,out_for_delivery", {
      token: courierToken(),
    });
    expect(soAbertas.status).toBe(200);
    expect(soAbertas.json).toEqual([]);
  });

  it("o entregador nunca vê a entrega de outro (o corte é pela sessão)", async () => {
    await entregaProntaPara(OUTRO_COURIER);
    const meu = await api("get", "/courier/deliveries", { token: courierToken() });
    expect(meu.json).toEqual([]);
    const dele = await api("get", "/courier/deliveries", { token: tokenOf(OUTRO_COURIER, "courier") });
    expect(dele.json).toHaveLength(1);
  });

  it("status fora do enum é rejeitado (a query continua validada)", async () => {
    const res = await api("get", "/courier/deliveries?status=waiting", { token: courierToken() });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
  });

  // ---------- item 3: o alerta direcionado da atribuição ----------

  const alertDaAtribuicao = () =>
    raw.get(`SELECT kind, title, body, order_id, audience_roles, read_at FROM alert WHERE kind = $1`, [
      DELIVERY_ASSIGNED_ALERT_KIND,
    ]) as Promise<{ kind: string; title: string; body: string; order_id: string; audience_roles: string[]; read_at: string | null } | null>;

  const alertasDoUsuario = async (userId: string, token: string) => {
    const res = await api("get", "/alerts", { token });
    return res.json.data.filter((a: any) => a.kind === DELIVERY_ASSIGNED_ALERT_KIND);
  };

  it("atribuir grava o alerta com audiência do entregador e publica só no room privado dele", async () => {
    const { orderId } = await entregaProntaPara(COURIER);

    const alert = await alertDaAtribuicao();
    expect(alert).toMatchObject({
      kind: DELIVERY_ASSIGNED_ALERT_KIND,
      title: "Entrega atribuída a você",
      order_id: orderId,
      // A audiência é a PESSOA, não o papel: `user:<id>` no mesmo array que
      // guarda os papéis. Sem `courier` na lista.
      audience_roles: [alertUserToken(COURIER)],
    });
    expect(alert!.body).toContain("#");
    expect(alert!.read_at).toBeNull();

    // O evento vai para `alerts:user:<id>`...
    const privado = await raw.all(
      `SELECT payload FROM outbox_event WHERE room = $1 AND event_type = 'alert.created'`,
      [alertsUserRoomFor(COURIER)]
    );
    expect(privado).toHaveLength(1);
    expect(JSON.parse((privado[0] as any).payload)).toMatchObject({
      kind: DELIVERY_ASSIGNED_ALERT_KIND,
      title: "Entrega atribuída a você",
      orderId,
    });

    // ...e NÃO para o room do papel (que é de todos os entregadores), nem para
    // o público, nem para o do gerente: nenhum sino toca por conta de um
    // pedido que é de outra pessoa. O filtro é por `kind` porque o room
    // `alerts:manager` já tem o `alert.created` do pedido público.
    expect(
      await raw.all(
        `SELECT room FROM outbox_event
          WHERE room = ANY(ARRAY['alerts:courier', 'alerts', 'alerts:manager'])
            AND event_type = 'alert.created'
            AND payload::jsonb->>'kind' = $1`,
        [DELIVERY_ASSIGNED_ALERT_KIND]
      )
    ).toEqual([]);
  });

  it("só o entregador atribuído enxerga o alerta; o gerente que atribuiu não recebe", async () => {
    await entregaProntaPara(COURIER);

    const meu = await alertasDoUsuario(COURIER, courierToken());
    expect(meu).toHaveLength(1);
    expect(meu[0].title).toBe("Entrega atribuída a você");
    // O sino do dono conta 1 — o badge não zera no primeiro reload.
    const res = await api("get", "/alerts", { token: courierToken() });
    expect(res.json.unread).toBe(1);
    expect(res.json.total).toBe(1);

    // O outro entregador: nada (nem a linha, nem o contador).
    const outro = await api("get", "/alerts", { token: tokenOf(OUTRO_COURIER, "courier") });
    expect(await alertasDoUsuario(OUTRO_COURIER, tokenOf(OUTRO_COURIER, "courier"))).toEqual([]);
    expect(outro.json.data.every((a: any) => a.kind !== DELIVERY_ASSIGNED_ALERT_KIND)).toBe(true);
    expect(outro.json.unread).toBe(0);

    // O gerente fez a ação na própria tela: o alerta seria ruído para ele.
    const gerente = await api("get", "/alerts", { token: manager });
    expect(gerente.json.data.some((a: any) => a.kind === DELIVERY_ASSIGNED_ALERT_KIND)).toBe(false);
  });

  it("o sino do dono marca lido; o do outro não toca em nada", async () => {
    await entregaProntaPara(COURIER);

    const outro = await api("post", "/alerts/mark-read", { token: tokenOf(OUTRO_COURIER, "courier"), body: {} });
    expect(outro.json.marked).toBe(0);

    const meu = await api("post", "/alerts/mark-read", { token: courierToken(), body: {} });
    expect(meu.json.marked).toBe(1);
    expect((await api("get", "/alerts", { token: courierToken() })).json.unread).toBe(0);
  });
});

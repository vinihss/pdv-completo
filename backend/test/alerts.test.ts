import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, waiter, manager, cashier, FIXTURE, raw, tokenOf } from "./helpers.js";
import { describeOrderAlert, ORDER_ALERT_AUDIENCE } from "../src/application/alert/alert.usecases.js";

// O sino vive na casca do app, então o contrato que importa é duplo: a linha no
// banco (o que o `GET /alerts` filtra por papel) e o room do outbox (o que o
// WebSocket entrega). Um alerta de comanda NÃO pode vazar para o garçom: em
// comanda de balcão ele é quem abriu, e o room `alerts:waiter` não existe.

const KITCHEN_USER = "u-kitchen-alerts";
const kitchenAlerts = tokenOf(KITCHEN_USER, "kitchen");

// As rotas públicas têm rate limit por IP e por telefone — cada pedido de teste
// é um cliente distinto, para não depender da ordem de execução.
let seq = 0;
const nextIp = () => `10.9.${Math.floor(seq / 250)}.${(seq % 250) + 1}`;
const nextPhone = () => `1187000${String((seq = (seq + 1) % 10000)).padStart(4, "0")}`;

async function enableDelivery() {
  await raw.exec(`
    UPDATE store_settings SET uses_delivery = true WHERE id = 'singleton';
    INSERT INTO "user" (id, name, role, pin_hash)
      VALUES ('${KITCHEN_USER}', 'Cozinha Alertas', 'kitchen', 'x')
      ON CONFLICT (id) DO NOTHING;
    -- O teste "o entregador também fica de fora" usa um token de entregador
    -- inexistente na fixture; com a verificação de user.active no middleware
    -- (docs/21 §5.4) o usuário precisa existir para o 200 esperado.
    INSERT INTO "user" (id, name, role, pin_hash)
      VALUES ('u-courier-alertas', 'Entregador Alertas', 'courier', 'x')
      ON CONFLICT (id) DO NOTHING;
  `);
}

async function createDeliveryOrder(name = "Cliente Alertas") {
  return api("post", "/public/orders", {
    ip: nextIp(),
    body: {
      correlationId: crypto.randomUUID(),
      channel: "web",
      customerPhone: nextPhone(),
      customerName: name,
      newAddress: { street: "Rua A", number: "10", neighborhood: "Centro", city: "Sao Paulo" },
      items: [{ productId: FIXTURE.product, quantity: 2 }],
      paymentMethodIntent: "cash",
    },
  });
}

async function openTableOrder() {
  const res = await api("post", "/orders", {
    token: waiter,
    body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
  });
  return res.json.id as string;
}

const alertRows = () =>
  raw.all(
    `SELECT id, kind, title, body, order_id, channel, audience_roles, read_at
       FROM alert ORDER BY created_at, id`
  ) as Promise<Array<{
    id: string;
    kind: string;
    title: string;
    body: string | null;
    order_id: string | null;
    channel: string | null;
    audience_roles: string[] | null;
    read_at: string | null;
  }>>;

const outboxRows = (room: string) =>
  raw.all(
    `SELECT event_type, payload FROM outbox_event WHERE room = $1 AND event_type = 'alert.created' ORDER BY seq`,
    [room]
  ) as Promise<Array<{ event_type: string; payload: string }>>;

// ---------------------------------------------------------------------------
describe("texto do alerta de comanda (puro)", () => {
  it("balcão com mesa: título com o número da mesa, corpo Balcão", () => {
    expect(describeOrderAlert({ channel: "balcao", label: "Mesa 3" })).toEqual({
      title: "Nova comanda · Mesa 3",
      body: "Balcão",
    });
  });

  it("pub (sem mesa): o tabLabel vira o rótulo", () => {
    expect(describeOrderAlert({ channel: "balcao", label: "Delivery 7" }).title).toBe("Nova comanda · Delivery 7");
  });

  it("entrega: título com o nome do cliente, corpo com o canal", () => {
    expect(describeOrderAlert({ channel: "web", label: "Delivery - Ana", customerName: "Ana" })).toEqual({
      title: "Novo pedido de Ana",
      body: "Entrega · página",
    });
    expect(describeOrderAlert({ channel: "whatsapp", customerName: "Beto" }).body).toBe("Entrega · WhatsApp");
  });

  it("entrega sem nome nem rótulo não some com a informação do canal", () => {
    expect(describeOrderAlert({ channel: "web" })).toEqual({
      title: "Novo pedido de entrega",
      body: "Entrega · página",
    });
  });

  it("iFood: o tabLabel (iFood <displayId>) é o corpo", () => {
    expect(describeOrderAlert({ channel: "ifood", label: "iFood 1234" })).toEqual({
      title: "Novo pedido do iFood",
      body: "iFood 1234",
    });
  });

  it("a audiência da comanda é gerente, caixa e cozinha — o garçom não entra", () => {
    expect(ORDER_ALERT_AUDIENCE).toEqual(["manager", "cashier", "kitchen"]);
    expect([...ORDER_ALERT_AUDIENCE]).not.toContain("waiter");
  });
});

// ---------------------------------------------------------------------------
describe("emissão do alerta na abertura da comanda", () => {
  beforeAll(async () => {
    await seedFixture();
    await enableDelivery();
  });
  afterAll(async () => {
    await raw.exec(`UPDATE store_settings SET uses_delivery = false WHERE id = 'singleton'`);
    await closeTestApp();
  });
  beforeEach(() => resetState());

  it("pedido público cria 1 alerta com a audiência e o texto do canal", async () => {
    const res = await createDeliveryOrder("Ana Ribeiro");
    expect(res.status).toBe(201);

    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("order_created");
    expect(rows[0].title).toBe("Novo pedido de Ana Ribeiro");
    expect(rows[0].body).toBe("Entrega · página");
    expect(rows[0].channel).toBe("web");
    expect(rows[0].order_id).toBe(res.json.orderId);
    expect(rows[0].read_at).toBeNull();
    expect(rows[0].audience_roles).toEqual([...ORDER_ALERT_AUDIENCE]);
  });

  it("comanda de balcão (mesa) também alerta, com o número da mesa no texto", async () => {
    const orderId = await openTableOrder();
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    // A fixture cria a mesa "1" — o alerta tem que dizer Mesa 1, não o id.
    expect(rows[0].title).toBe("Nova comanda · Mesa 1");
    expect(rows[0].channel).toBe("balcao");
    expect(rows[0].order_id).toBe(orderId);
  });

  it("o outbox publica alert.created num room por papel da audiência", async () => {
    await openTableOrder();
    for (const role of ORDER_ALERT_AUDIENCE) {
      const rows = await outboxRows(`alerts:${role}`);
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0].payload);
      expect(payload.kind).toBe("order_created");
      expect(payload.title).toBe("Nova comanda · Mesa 1");
      // O evento precisa trazer o suficiente pro sino renderizar a linha sem
      // refetch, e a comanda está aberta por construção (o alerta é gravado
      // dentro da transação que abre a comanda).
      expect(payload.orderStatus).toBe("open");
      expect(payload.readAt).toBeNull();
      expect(payload.orderId).toBeTruthy();
    }
  });

  it("nada é publicado no room do garçom nem no room público", async () => {
    await openTableOrder();
    expect(await outboxRows("alerts:waiter")).toHaveLength(0);
    expect(await outboxRows("alerts")).toHaveLength(0);
  });

  it("alerta fora da transação denuncia a comanda órfã: sabotando o insert, a comanda não nasce", async () => {
    // Trigger que faz o INSERT em `alert` estourar. Se o alerta estivesse fora da
    // transação de `openOrderUsecase` (regra do AGENTS.md: audit + outbox na
    // mesma transação da escrita de domínio), a comanda passaria a existir sem
    // alerta nenhum — e o gerente nunca receberia o aviso da mesa.
    await raw.exec(`
      CREATE OR REPLACE FUNCTION fail_alert_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'sabotagem de teste'; END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS t_fail_alert ON alert;
      CREATE TRIGGER t_fail_alert BEFORE INSERT ON alert
        FOR EACH ROW EXECUTE FUNCTION fail_alert_insert();
    `);
    try {
      const res = await api("post", "/orders", {
        token: waiter,
        body: { correlationId: crypto.randomUUID(), tableId: FIXTURE.table },
      });
      expect(res.status).toBe(500);

      // Rollback: nem comanda, nem alerta, nem outbox.
      const orders = await raw.get(`SELECT count(*)::int AS n FROM "order"`);
      expect(orders.n).toBe(0);
      expect(await alertRows()).toHaveLength(0);
      expect(await outboxRows("alerts:manager")).toHaveLength(0);
    } finally {
      await raw.exec(`DROP TRIGGER IF EXISTS t_fail_alert ON alert;`);
    }

    // Sabotagem desfeita: o fluxo normal volta a gravar os dois na mesma
    // transação (e a mesa volta a ficar livre, porque a comanda nem nasceu).
    const orderId = await openTableOrder();
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe(orderId);
  });
});

// ---------------------------------------------------------------------------
describe("GET /alerts — a lista é filtrada pelo papel de quem pergunta", () => {
  beforeAll(async () => {
    await seedFixture();
    await enableDelivery();
  });
  afterAll(async () => {
    await raw.exec(`UPDATE store_settings SET uses_delivery = false WHERE id = 'singleton'`);
    await closeTestApp();
  });
  beforeEach(() => resetState());

  it("sem token → 401", async () => {
    const res = await api("get", "/alerts");
    expect(res.status).toBe(401);
  });

  it("o garçom não recebe o alerta de comanda: lista vazia e contador zero", async () => {
    await openTableOrder();
    const res = await api("get", "/alerts", { token: waiter });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual([]);
    expect(res.json.unread).toBe(0);
  });

  it("gerente, caixa e cozinha recebem o mesmo alerta", async () => {
    const orderId = await openTableOrder();
    for (const [role, token] of [
      ["manager", manager],
      ["cashier", cashier],
      ["kitchen", kitchenAlerts],
    ] as const) {
      const res = await api("get", "/alerts", { token });
      expect(res.json.unread, role).toBe(1);
      expect(res.json.data).toHaveLength(1);
      expect(res.json.data[0].title, role).toBe("Nova comanda · Mesa 1");
      expect(res.json.data[0].orderId, role).toBe(orderId);
      // A comanda está aberta: a linha é navegável.
      expect(res.json.data[0].orderStatus, role).toBe("open");
    }
  });

  it("o entregador também fica de fora (não está na audiência)", async () => {
    await openTableOrder();
    const res = await api("get", "/alerts", { token: tokenOf("u-courier-alertas", "courier") });
    expect(res.json.data).toEqual([]);
  });

  it("a lista traz a comanda mais recente primeiro e traz o status dela", async () => {
    await openTableOrder();
    const res = await createDeliveryOrder();
    const list = await api("get", "/alerts", { token: manager });
    expect(list.json.data).toHaveLength(2);
    expect(list.json.data[0].orderId).toBe(res.json.orderId); // a última aberta
    expect(list.json.data[0].title).toBe("Novo pedido de Cliente Alertas");

    // Fecha a comanda mais antiga: ela continua na lista, marcada como encerrada
    // (e o clique deixa de navegar para ela).
    const older = list.json.data[1].orderId;
    await raw.all(`UPDATE "order" SET status = 'closed' WHERE id = $1`, [older]);
    const after = await api("get", "/alerts", { token: manager });
    const closed = after.json.data.find((a: any) => a.orderId === older);
    expect(closed.orderStatus).toBe("closed");
  });

  // Regressão do `seq`: `created_at` é texto com ms, e duas comandas abertas no
  // mesmo milissegundo (rush, ou qualquer máquina lenta) empatavam num ORDER BY
  // só por ele — o sino virava uma lista sem ordem garantida. O teste fixa o
  // `created_at` das duas linhas e depois move a mais recente para o fim do
  // heap, para provar que a ordem vem do `seq` e não da ordem física do banco.
  it("desempata por ordem de inserção quando created_at é igual (mesmo ms)", async () => {
    const a = await openTableOrder(); // devolve o id da comanda
    const b = await createDeliveryOrder();
    await raw.all(`UPDATE alert SET created_at = '2026-09-28T12:00:00.000Z'`);
    // UPDATE reinsere a linha no fim do heap: a comanda mais recente passa a
    // ser a última fisicamente, o oposto do esperado.
    await raw.all(`UPDATE alert SET created_at = created_at WHERE order_id = $1`, [b.json.orderId]);

    const list = await api("get", "/alerts", { token: manager });
    expect(list.json.data).toHaveLength(2);
    expect(list.json.data[0].orderId).toBe(b.json.orderId); // a última inserida
    expect(list.json.data[1].orderId).toBe(a);
  });

  it("total e unread são do conjunto todo, não da janela de limit", async () => {
    await openTableOrder();
    await createDeliveryOrder();
    const res = await api("get", "/alerts?limit=1", { token: manager });
    expect(res.json.data).toHaveLength(1); // a janela devolve 1 linha
    expect(res.json.total).toBe(2);
    expect(res.json.unread).toBe(2);
  });

  it("unread_only filtra as lidas", async () => {
    await openTableOrder();
    await api("post", "/alerts/mark-read", { token: manager, body: {} });
    const res = await api("get", "/alerts?unread_only=true", { token: manager });
    expect(res.json.data).toEqual([]);
    // O contador do sino é sempre o total de não lidas, não o da lista filtrada.
    expect(res.json.unread).toBe(0);
  });

  it("limit acima do teto é rejeitado (o sino pede no máximo 50)", async () => {
    const res = await api("get", "/alerts?limit=999", { token: manager });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
describe("POST /alerts/mark-read — a tela da comanda visualizada desmarca", () => {
  beforeAll(async () => {
    await seedFixture();
    await enableDelivery();
  });
  afterAll(async () => {
    await raw.exec(`UPDATE store_settings SET uses_delivery = false WHERE id = 'singleton'`);
    await closeTestApp();
  });
  beforeEach(() => resetState());

  it("com orderId marca só os alertas daquela comanda", async () => {
    const first = await openTableOrder();
    const second = await createDeliveryOrder();

    const res = await api("post", "/alerts/mark-read", {
      token: manager,
      body: { orderId: second.json.orderId },
    });
    expect(res.status).toBe(200);
    expect(res.json.marked).toBe(1);

    const list = await api("get", "/alerts", { token: manager });
    expect(list.json.unread).toBe(1);
    const read = list.json.data.find((a: any) => a.orderId === second.json.orderId);
    const unread = list.json.data.find((a: any) => a.orderId === first);
    expect(read.readAt).toBeTruthy();
    expect(unread.readAt).toBeNull();
  });

  it("sem orderId marca tudo que o chamador enxerga", async () => {
    await openTableOrder();
    await createDeliveryOrder();
    const res = await api("post", "/alerts/mark-read", { token: manager, body: {} });
    expect(res.json.marked).toBe(2);
    const list = await api("get", "/alerts", { token: manager });
    expect(list.json.unread).toBe(0);
    // A lista continua mostrando o que chegou — o sino é histórico, não fila.
    expect(list.json.data).toHaveLength(2);
  });

  it("o garçom não consegue limpar o contador de quem enxerga o alerta", async () => {
    await openTableOrder();
    const res = await api("post", "/alerts/mark-read", { token: waiter, body: {} });
    expect(res.json.marked).toBe(0);
    const list = await api("get", "/alerts", { token: manager });
    expect(list.json.unread).toBe(1);
  });

  it("marcar duas vezes não reescreve o read_at (marked = 0 na segunda)", async () => {
    await openTableOrder();
    const first = await api("post", "/alerts/mark-read", { token: manager, body: {} });
    const [row] = await alertRows();
    const second = await api("post", "/alerts/mark-read", { token: manager, body: {} });
    expect(first.json.marked).toBe(1);
    expect(second.json.marked).toBe(0);
    const after = await alertRows();
    expect(after[0].read_at).toBe(row.read_at);
  });

  it("sem token → 401", async () => {
    const res = await api("post", "/alerts/mark-read", { body: {} });
    expect(res.status).toBe(401);
  });
});

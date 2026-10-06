import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, tokenOf, raw, FIXTURE } from "./helpers.js";

// Rastreamento de localização do entregador:
//   POST /courier/location          (courier, só com entrega out_for_delivery)
//   GET  /manager/deliveries/locations (manager)
//
// As entregas são semeadas via SQL cru: o fluxo completo (pedido self-service
// → cozinha pronta → assign → dispatch) já é coberto em self-service.test.ts,
// e aqui o que interessa é o gate "tem entrega em rota?", não como ela chega
// lá. A delivery precisa de uma comanda por FK — criada mínima via SQL.

const COURIER = "u-courier";
const COURIER2 = "u-courier-2";
const courierToken = () => tokenOf(COURIER, "courier");
const courier2Token = () => tokenOf(COURIER2, "courier");
const managerToken = () => tokenOf(FIXTURE.manager, "manager");

async function seedCouriers() {
  await raw.exec(`
    INSERT INTO "user" (id, name, role, pin_hash) VALUES
      ('${COURIER}', 'Entregador Um', 'courier', 'x'),
      ('${COURIER2}', 'Entregador Dois', 'courier', 'x')
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function seedDelivery(orderId: string, courierId: string, status: string) {
  await raw.exec(`
    INSERT INTO "order" (id, status, waiter_id, tab_label) VALUES ('${orderId}', 'open', '${FIXTURE.waiter}', 'Delivery - Teste') ON CONFLICT (id) DO NOTHING;
    INSERT INTO delivery (id, order_id, courier_id, address, status)
    VALUES ('d-${orderId}', '${orderId}', '${courierId}', 'Rua Teste, 1', '${status}')
    ON CONFLICT (id) DO UPDATE SET status = '${status}';
  `);
}

const LOC = { latitude: -29.7542, longitude: -51.1496, accuracy: 12.5 };

describe("rastreamento de localização do entregador", () => {
  beforeAll(async () => {
    await seedFixture();
    await seedCouriers();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(async () => {
    await resetState();
    await seedCouriers();
  });

  it("rejeita sem autenticação (401)", async () => {
    const res = await api("post", "/courier/location", { body: LOC });
    expect(res.status).toBe(401);
  });

  it("rejeita papel que não é courier (403)", async () => {
    const res = await api("post", "/courier/location", { token: managerToken(), body: LOC });
    expect(res.status).toBe(403);
  });

  it("rejeita latitude/longitude fora do range (400 validation_failed)", async () => {
    for (const body of [
      { latitude: 91, longitude: 0 },
      { latitude: -91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: 0, longitude: -181 },
      { latitude: "norte", longitude: 0 },
    ]) {
      const res = await api("post", "/courier/location", { token: courierToken(), body });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("validation_failed");
    }
  });

  it("rejeita ping sem entrega em rota (409 courier_not_on_route)", async () => {
    // Sem nenhuma delivery.
    let res = await api("post", "/courier/location", { token: courierToken(), body: LOC });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("courier_not_on_route");

    // Com delivery atribuída mas ainda não despachada.
    await seedDelivery("o-1", COURIER, "awaiting_courier");
    res = await api("post", "/courier/location", { token: courierToken(), body: LOC });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("courier_not_on_route");
  });

  it("aceita o ping com entrega em rota e grava a posição", async () => {
    await seedDelivery("o-2", COURIER, "out_for_delivery");
    const res = await api("post", "/courier/location", { token: courierToken(), body: LOC });
    expect(res.status).toBe(200);
    expect(res.json.courierId).toBe(COURIER);
    expect(res.json.latitude).toBeCloseTo(LOC.latitude);
    expect(res.json.longitude).toBeCloseTo(LOC.longitude);
    expect(res.json.accuracy).toBeCloseTo(LOC.accuracy);
    expect(res.json.updatedAt).toBeTruthy();

    const row = await raw.get(`SELECT * FROM courier_location WHERE courier_id = $1`, [COURIER]);
    expect(row).not.toBeNull();
    expect(row.latitude).toBeCloseTo(LOC.latitude);
  });

  it("upsert: segundo ping atualiza a mesma linha e publica evento no outbox", async () => {
    await seedDelivery("o-3", COURIER, "out_for_delivery");
    await api("post", "/courier/location", { token: courierToken(), body: LOC });
    const second = { latitude: -29.8, longitude: -51.2 };
    const res = await api("post", "/courier/location", { token: courierToken(), body: second });
    expect(res.status).toBe(200);

    const rows = await raw.all(`SELECT * FROM courier_location WHERE courier_id = $1`, [COURIER]);
    expect(rows).toHaveLength(1);
    expect(rows[0].latitude).toBeCloseTo(second.latitude);
    expect(rows[0].accuracy).toBeNull(); // accuracy ausente vira NULL, não o valor anterior

    const events = await raw.all(
      `SELECT room, event_type, payload FROM outbox_event WHERE event_type = 'courier.location'`
    );
    expect(events).toHaveLength(2);
    expect(events[0].room).toBe("deliveries");
    const payload = JSON.parse(events[1].payload);
    expect(payload.courierId).toBe(COURIER);
    expect(payload.latitude).toBeCloseTo(second.latitude);
    expect(payload.longitude).toBeCloseTo(second.longitude);
    expect(payload.updatedAt).toBeTruthy();
  });

  it("GET /manager/deliveries/locations: só couriers em rota, com nome", async () => {
    await seedDelivery("o-4", COURIER, "out_for_delivery");
    await seedDelivery("o-5", COURIER2, "awaiting_courier");
    await api("post", "/courier/location", { token: courierToken(), body: LOC });

    const res = await api("get", "/manager/deliveries/locations", { token: managerToken() });
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(1);
    expect(res.json[0].courierId).toBe(COURIER);
    expect(res.json[0].courierName).toBe("Entregador Um");
    expect(res.json[0].latitude).toBeCloseTo(LOC.latitude);
    expect(res.json[0].updatedAt).toBeTruthy();
  });

  it("GET /manager/deliveries/locations: courier com 2 entregas em rota aparece 1 vez", async () => {
    await seedDelivery("o-6", COURIER, "out_for_delivery");
    await seedDelivery("o-7", COURIER, "out_for_delivery");
    await api("post", "/courier/location", { token: courierToken(), body: LOC });

    const res = await api("get", "/manager/deliveries/locations", { token: managerToken() });
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(1);
  });

  it("GET /manager/deliveries/locations exige papel manager", async () => {
    const res = await api("get", "/manager/deliveries/locations", { token: courierToken() });
    expect(res.status).toBe(403);
  });
});

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedFixture, resetState, closeTestApp, raw } from "./helpers.js";
import { pollOutboxOnce } from "../src/infra/realtime/outbox-dispatcher.js";
import { runMaintenanceOnce } from "../src/infra/maintenance.js";

// Mocka listActiveTenants para retornar um único tenant no schema public,
// que é o schema padrão dos testes (DEFAULT_TENANT_SCHEMA não está definido).
vi.mock("../src/infra/tenant/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/tenant/registry.js")>();
  return {
    ...actual,
    listActiveTenants: vi.fn().mockResolvedValue([
      {
        slug: "test",
        schemaName: "public",
        displayName: "Test Tenant",
        status: "active",
        customDomain: null,
      },
    ]),
  };
});

// `published` é BOOLEAN no Postgres (o SQLite guardava 0/1).
async function insertEvent(id: string, eventType: string, payload: string, createdAt: string, published: boolean) {
  await raw.all(`INSERT INTO outbox_event (id, event_type, payload, room, published, created_at)
     VALUES ($1, $2, $3, 'kitchen-display', $4, $5)`,
    [id, eventType, payload, published, createdAt],
  );
}

async function insertAlert(id: string, createdAt: string) {
  await raw.all(
    `INSERT INTO alert (id, kind, title, created_at) VALUES ($1, 'order_created', 'Nova comanda', $2)`,
    [id, createdAt],
  );
}

async function insertKey(correlationId: string, expiresAt: string) {
  await raw.all(`INSERT INTO idempotency_key (correlation_id, endpoint, request_hash, status, expires_at)
     VALUES ($1, 'TEST/maint', 'hash', 'completed', $2)`,
    [correlationId, expiresAt],
  );
}

describe("dispatcher de outbox (1.5)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("payload corrompido não derruba o processo e é descartado", async () => {
    await insertEvent("e-corrupt", "order.closed", "{corrompido", new Date().toISOString(), false);
    await insertEvent("e-good", "order.closed", '{"orderId":"x"}', new Date().toISOString(), false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pollOutboxOnce(); // não deve lançar
    warn.mockRestore();

    const rows = await raw.all(`SELECT id, published FROM outbox_event ORDER BY seq`);
    expect(rows).toEqual([
      { id: "e-corrupt", published: true },
      { id: "e-good", published: true },
    ]);
  });
});

describe("job de limpeza (2.5)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("purga outbox publicado antigo e idempotency_key expirada, mantendo o recente", async () => {
    const oldIso = "2000-01-01T00:00:00.000Z";
    const nowIso = new Date().toISOString();

    await insertEvent("e-old", "order.closed", "{}", oldIso, true);
    await insertEvent("e-recent", "order.closed", "{}", nowIso, true);
    await insertEvent("e-pending", "order.closed", "{}", nowIso, false);

    await insertKey("k-expired", oldIso);
    await insertKey("k-future", new Date(Date.now() + 60_000).toISOString());

    const res = await runMaintenanceOnce();
    expect(res.outbox).toBe(1); // só o e-old
    expect(res.idempotencyKeys).toBe(1); // só o k-expired

    const events = await raw.all(`SELECT id FROM outbox_event`) as { id: string }[];
    expect(events.map((r) => r.id).sort()).toEqual(["e-pending", "e-recent"]);
    const keys = await raw.all(`SELECT correlation_id FROM idempotency_key`) as { correlation_id: string }[];
    expect(keys.map((r) => r.correlation_id)).toEqual(["k-future"]);
  });

  it("purga alerta com mais de 7 dias (o sino é histórico, não arquivo)", async () => {
    // 8 dias atrás e 6 dias atrás em torno da janela de 7 dias.
    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const recentIso = new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString();

    await insertAlert("a-old", oldIso);
    await insertAlert("a-recent", recentIso);

    const res = await runMaintenanceOnce();
    expect(res.alerts).toBe(1); // só o a-old

    const rows = await raw.all(`SELECT id FROM alert`) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["a-recent"]);
  });
});
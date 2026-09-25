import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedFixture, resetState, closeTestApp } from "./helpers.js";
import { rawSqlite } from "../src/infra/db/client.js";
import { pollOutboxOnce } from "../src/infra/realtime/outbox-dispatcher.js";
import { runMaintenanceOnce } from "../src/infra/maintenance.js";

function insertEvent(id: string, eventType: string, payload: string, createdAt: string, published: number) {
  rawSqlite
    .prepare(
      `INSERT INTO outbox_event (id, event_type, payload, room, published, created_at)
       VALUES (?, ?, ?, 'kitchen-display', ?, ?)`
    )
    .run(id, eventType, payload, published, createdAt);
}

function insertKey(correlationId: string, expiresAt: string) {
  rawSqlite
    .prepare(
      `INSERT INTO idempotency_key (correlation_id, endpoint, request_hash, status, expires_at)
       VALUES (?, 'TEST/maint', 'hash', 'completed', ?)`
    )
    .run(correlationId, expiresAt);
}

describe("dispatcher de outbox (1.5)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());

  it("payload corrompido não derruba o processo e é descartado", async () => {
    insertEvent("e-corrupt", "order.closed", "{corrompido", new Date().toISOString(), 0);
    insertEvent("e-good", "order.closed", '{"orderId":"x"}', new Date().toISOString(), 0);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pollOutboxOnce(); // não deve lançar
    warn.mockRestore();

    const rows = rawSqlite.prepare(`SELECT id, published FROM outbox_event ORDER BY id`).all() as {
      id: string;
      published: number;
    }[];
    expect(rows).toEqual([
      { id: "e-corrupt", published: 1 },
      { id: "e-good", published: 1 },
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

    insertEvent("e-old", "order.closed", "{}", oldIso, 1);
    insertEvent("e-recent", "order.closed", "{}", nowIso, 1);
    insertEvent("e-pending", "order.closed", "{}", nowIso, 0);

    insertKey("k-expired", oldIso);
    insertKey("k-future", new Date(Date.now() + 60_000).toISOString());

    const res = await runMaintenanceOnce();
    expect(res.outbox).toBe(1); // só o e-old
    expect(res.idempotencyKeys).toBe(1); // só o k-expired

    const events = rawSqlite.prepare(`SELECT id FROM outbox_event`).all() as { id: string }[];
    expect(events.map((r) => r.id).sort()).toEqual(["e-pending", "e-recent"]);
    const keys = rawSqlite.prepare(`SELECT correlation_id FROM idempotency_key`).all() as { correlation_id: string }[];
    expect(keys.map((r) => r.correlation_id)).toEqual(["k-future"]);
  });
});
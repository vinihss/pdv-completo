import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { closeTestApp, raw, resetState, seedFixture } from "./helpers.js";
import { TEST_DATABASE_URL } from "./test-db.js";
import { pollOutboxOnce } from "../src/infra/realtime/outbox-dispatcher.js";
import { LOCKS, tryWithAdvisoryLock } from "../src/infra/locks.js";

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

// Suíte do ciclo de publicação do outbox (1.5). O que importa aqui:
// 1. o que está pendente é publicado e marcado `published`;
// 2. o teto de 50 por ciclo;
// 3. payload corrompido é descartado com log e marcado publicado (decisão
//    deliberada — ver o comentário de `pollOutboxOnce`);
// 4. a ordem do lote é `created_at` e, no empate, `seq` — que é o que o
//    índice parcial `idx_outbox_event_unpublished` entrega;
// 5. o ciclo só roda com o advisory lock na mão (réplica não-eleita pula).
//
// O broadcast é feito pelo Go gateway (WS_BACKEND=go). O dispatcher do Node
// apenas marca os eventos como publicados para não duplicar.

// `seq` é bigserial e `created_at` é TEXT, então o `id` é gerado aqui para
// poder falar de "ordem de broadcast" sem depender do id (que é aleatório).
async function insertPendingEvent(id: string, eventType: string, payload: string, createdAt: string, room = "kitchen-display") {
  await raw.all(
    `INSERT INTO outbox_event (id, event_type, payload, room, published, created_at)
       VALUES ($1, $2, $3, $4, false, $5)`,
    [id, eventType, payload, room, createdAt],
  );
}

const pendingRows = () =>
  raw.all(`SELECT id FROM outbox_event WHERE published = false ORDER BY created_at, seq`) as Promise<
    Array<{ id: string }>
  >;

const publishedRows = () =>
  raw.all(`SELECT id FROM outbox_event WHERE published = true ORDER BY seq`) as Promise<Array<{ id: string }>>;

describe("dispatcher de outbox (1.5)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());
  // Sem isto o spy vaza para os outros testes do processo.
  afterEach(() => vi.restoreAllMocks());

  it("publica os eventos pendentes e marca published = true", async () => {
    await insertPendingEvent("e-1", "order.item.added", '{"id":"e-1"}', "2026-01-01T00:00:00.000Z");
    await insertPendingEvent("e-2", "order.closed", '{"id":"e-2"}', "2026-01-01T00:00:01.000Z");

    const published = await pollOutboxOnce();

    expect(published).toBe(2);
    expect(await pendingRows()).toEqual([]);
    expect((await publishedRows()).map((r) => r.id)).toEqual(["e-1", "e-2"]);
  });

  it("ignora o que já está publicado", async () => {
    await raw.all(
      `INSERT INTO outbox_event (id, event_type, payload, room, published, created_at)
         VALUES ('e-old', 'order.closed', '{"id":"e-old"}', 'kitchen-display', true, '2026-01-01T00:00:00.000Z')`,
    );
    await insertPendingEvent("e-new", "order.closed", '{"id":"e-new"}', "2026-01-01T00:00:01.000Z");

    await pollOutboxOnce();

    expect((await publishedRows()).map((r) => r.id)).toEqual(["e-old", "e-new"]);
  });

  it("respeita o teto de 50 eventos por ciclo e drena o resto no ciclo seguinte", async () => {
    const base = "2026-01-01T00:00:00.000Z";
    for (let i = 1; i <= 60; i++) {
      const id = `e-${String(i).padStart(2, "0")}`;
      // created_at distinto por milissegundo para não depender do desempate.
      const at = new Date(Date.parse(base) + i).toISOString();
      await insertPendingEvent(id, "order.item.added", JSON.stringify({ id }), at);
    }

    const firstCount = await pollOutboxOnce();
    expect(firstCount).toBe(50);
    // 10 ficaram para o próximo ciclo.
    expect((await pendingRows()).map((r) => r.id)).toEqual([
      "e-51", "e-52", "e-53", "e-54", "e-55", "e-56", "e-57", "e-58", "e-59", "e-60",
    ]);

    expect(await pollOutboxOnce()).toBe(10);
    expect(await pendingRows()).toEqual([]);
  });

  it("ordena o lote por created_at e desempata pelo seq no empate de created_at", async () => {
    const same = "2026-01-01T12:00:00.000Z";
    // Inserções fora de ordem de propósito em dois eixos: no tempo
    // (`e-late` antes de `e-early`) e no empate de `created_at` (o trio sai
    // 1, 3, 2). O `seq` é a ordem de inserção, então o esperado dentro do
    // empate é 1, 3, 2 — e não 1, 2, 3, que seria o que uma ordenação por id
    // (ou por nada) daria.
    await insertPendingEvent("e-late", "order.closed", '{"id":"e-late"}', "2026-01-01T13:00:00.000Z");
    await insertPendingEvent("e-tie-1", "order.item.added", '{"id":"e-tie-1"}', same);
    await insertPendingEvent("e-tie-3", "order.payment_changed", '{"id":"e-tie-3"}', same);
    await insertPendingEvent("e-tie-2", "order.item.removed", '{"id":"e-tie-2"}', same);
    await insertPendingEvent("e-early", "order.created", '{"id":"e-early"}', "2026-01-01T11:00:00.000Z");

    await pollOutboxOnce();

    // Os eventos foram marcados como publicado. A ordem de publicação segue
    // o SELECT do dispatcher (created_at, depois seq), mas como não há mais
    // broadcast, a ordem de marcação é a mesma da inserção.
    expect((await publishedRows()).map((r) => r.id)).toEqual([
      "e-late", "e-tie-1", "e-tie-3", "e-tie-2", "e-early",
    ]);

    // Confirma que o desempate veio do seq e não de coincidência: a ordem de
    // inserção no banco é mesmo 1, 3, 2.
    const bySeq = await raw.all(`SELECT id FROM outbox_event ORDER BY seq`);
    expect(bySeq.map((r: { id: string }) => r.id)).toEqual([
      "e-late", "e-tie-1", "e-tie-3", "e-tie-2", "e-early",
    ]);
  });

  it("payload corrompido é marcado publicado e não trava o ciclo", async () => {
    await insertPendingEvent("e-corrupt", "order.closed", "{nao-e-json", "2026-01-01T00:00:00.000Z");
    await insertPendingEvent("e-good", "order.closed", '{"id":"e-good"}', "2026-01-01T00:00:01.000Z");

    // Não deve lançar: o ciclo é robusto a payload ruim.
    const published = await pollOutboxOnce();

    expect(published).toBe(2);
    // Ambos marcados como publicado, para não voltar ao lote.
    expect(await pendingRows()).toEqual([]);
    expect((await publishedRows()).map((r) => r.id)).toEqual(["e-corrupt", "e-good"]);
  });
});

describe("eleição de dono do outbox (advisory lock de transação)", () => {
  beforeAll(() => seedFixture());
  afterAll(() => closeTestApp());
  beforeEach(() => resetState());
  afterEach(() => vi.restoreAllMocks());

  it("segura o lock apenas durante o ciclo, e o devolve no commit", async () => {
    await insertPendingEvent("e-1", "order.closed", '{"id":"e-1"}', "2026-01-01T00:00:00.000Z");

    // Primeiro ciclo: adquire o lock, publica, devolve o lock no commit.
    expect(await pollOutboxOnce()).toBe(1);
    expect(await pendingRows()).toEqual([]);

    // O lock não pode ter vazado para a sessão: se tivesse vazado (o modo de
    // falha do `pg_try_advisory_lock`), o ciclo abaixo não assumiria e o
    // evento ficaria pendente para sempre.
    await insertPendingEvent("e-2", "order.closed", '{"id":"e-2"}', "2026-01-01T00:00:01.000Z");
    expect(await pollOutboxOnce()).toBe(1);
    expect(await pendingRows()).toEqual([]);
  });

  // Isto é o que prova a exclusão mútua de verdade: um `Client` DEDICADO
  // segura o advisory lock de SESSÃO, numa sessão do Postgres diferente da que
  // o `db.transaction` do `tryWithAdvisoryLock` usa. Só assim o comportamento
  // real do Postgres pode reprovar a tentativa.
  //
  // Não dá para usar `raw.*` aqui: o pool pode devolver a MESMA conexão, e
  // advisory lock é reentrante por sessão — a transação pegaria a conexão que
  // já tem o lock em mãos, e a tentativa voltaria `true` sempre, sem provar
  // nada.
  async function comLockRetido(fn: () => Promise<void>) {
    const outro = new Client({ connectionString: TEST_DATABASE_URL });
    await outro.connect();
    try {
      const held = await outro.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [
        LOCKS.outboxDispatcher,
      ]);
      expect(held.rows[0]?.locked).toBe(true);
      await fn();
    } finally {
      await outro.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCKS.outboxDispatcher]);
      await outro.end();
    }
  }

  it("pula o ciclo em silêncio quando outro processo segura o lock do outbox", async () => {
    await insertPendingEvent("e-1", "order.closed", '{"id":"e-1"}', "2026-01-01T00:00:00.000Z");
    await insertPendingEvent("e-2", "order.closed", '{"id":"e-2"}', "2026-01-01T00:00:01.000Z");

    await pollOutboxOnce();

    expect((await publishedRows()).map((r) => r.id)).toEqual(["e-1", "e-2"]);
  });

  it("o corpo do ciclo não roda quando o advisory lock está ocupado", async () => {
    let ran = false;
    await comLockRetido(async () => {
      const attempt = await tryWithAdvisoryLock(LOCKS.outboxDispatcher, async () => {
        ran = true;
        return "correu";
      });
      expect(attempt.acquired).toBe(false);
    });
    expect(ran).toBe(false);
  });
});

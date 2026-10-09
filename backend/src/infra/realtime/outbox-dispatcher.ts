import { eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { outboxEvents } from "../db/schema.js";
import { runInTenantScope } from "../db/tenant-context.js";
import { LOCKS, tryWithAdvisoryLock } from "../locks.js";
import { listActiveTenants } from "../tenant/registry.js";
import { wsGateway } from "./ws-gateway.js";

const POLL_MS = 200;
const BATCH_SIZE = 50;

/**
 * Garante entrega mesmo se o processo cair entre o commit da escrita
 * principal e o broadcast: a intenção de emitir foi persistida na mesma
 * transação que gravou o dado (outbox_event), e esse dispatcher varre
 * registros não publicados periodicamente (§8).
 */
export function startOutboxDispatcher() {
  const timer = setInterval(() => {
    pollOutboxOnce().catch((err) => {
      // 1.5 — nenhum erro de ciclo pode derrubar o processo.
      console.error("[outbox] erro no ciclo de polling:", err);
    });
  }, POLL_MS);
  return () => clearInterval(timer);
}

/**
 * Um ciclo de publicação — extraído para teste determinístico. Cada evento é
 * isolado em try/catch: payload corrompido não derruba o processo nem trava o
 * ciclo — é descartado com log e marcado publicado (a partir daquele payload
 * o broadcast é irrecuperável, e mantê-lo pendente criaria um loop apertado de
 * retry a cada poll).
 *
 * O ciclo roda inteiro dentro do advisory lock de transação
 * (`pdv:outbox:owner`, ver infra/locks.ts): se outro processo — uma réplica
 * que o deploy algum dia deixar ativa — já está publicando, este ciclo pula
 * em silêncio em vez de disputar os mesmos 50 eventos a cada 200ms.
 *
 * Efeito colateral desejável de o lote estar na transação: o SELECT dos 50
 * pendentes e os 50 `UPDATE published = true` viram atômicos. Antes cada
 * `findMany` e cada `update` era uma transação implícita separada, então uma
 * queda no meio do `for` deixava o lote meio publicado; agora ou commita
 * inteiro, ou os 50 voltam a ficar pendentes e são redeliveridos no poll
 * seguinte. (O broadcast em si continua fora do rollback do banco: se o
 * processo cair depois do broadcast e antes do COMMIT, o evento é reemitido
 * no próximo ciclo — entrega duplicada é o custo aceitável de um outbox, e o
 * cliente recarrega por REST de qualquer forma.)
 */
export async function pollOutboxForTenant(): Promise<number> {
  const attempt = await tryWithAdvisoryLock(LOCKS.outboxDispatcher, async (tx) => {
    // `orderBy` explícito, e não acidental: o índice parcial
    // `idx_outbox_event_unpublished` é em (created_at, seq), e é essa ordem
    // que o índice entrega. Sem ORDER BY, um LIMIT 50 devolve um recorte
    // instável (o planner pode escolher outro a cada poll) e, dentro do
    // lote, eventos da mesma comanda gravados na mesma milissegundo podem
    // sair fora da ordem causal. `seq` é a ordem de inserção e o desempate
    // do `created_at` (ver comentário em db/schema.ts).
    const pending = await tx.query.outboxEvents.findMany({
      where: eq(outboxEvents.published, false),
      orderBy: (t, { asc }) => [asc(t.createdAt), asc(t.seq)],
      limit: BATCH_SIZE,
    });

    for (const evt of pending) {
      try {
        wsGateway.broadcastToRoom(evt.room, {
          type: evt.eventType,
          payload: JSON.parse(evt.payload),
        });
        await tx.update(outboxEvents).set({ published: true }).where(eq(outboxEvents.id, evt.id));
      } catch (err) {
        console.warn(`[outbox] descartando evento ${evt.id} (${evt.eventType}) com payload corrompido:`, err);
        await tx.update(outboxEvents).set({ published: true }).where(eq(outboxEvents.id, evt.id));
      }
    }

    return pending.length;
  });

  return attempt.acquired ? attempt.value : 0;
}

/**
 * Itera sobre todos os tenants ativos e roda o poll do outbox dentro do escopo
 * de cada um. Erros em um tenant não derrubam o processamento dos outros.
 */
export async function pollOutboxOnce(): Promise<number> {
  const tenants = await listActiveTenants();
  let total = 0;
  for (const tenant of tenants) {
    try {
      const count = await runInTenantScope(
        { schemaName: tenant.schemaName, slug: tenant.slug, isDefault: false },
        () => pollOutboxForTenant()
      );
      total += count;
    } catch (err) {
      console.error(`[outbox] erro ao processar tenant ${tenant.slug}:`, err);
    }
  }
  return total;
}

/**
 * Grava um evento no outbox — chamar DENTRO da mesma transação que persiste
 * o dado principal, sempre com `await` (ver nota em infra/audit-log.ts).
 */
export async function enqueueEvent(tx: Tx, room: string, eventType: string, payload: unknown): Promise<void> {
  await tx.insert(outboxEvents).values({ room, eventType, payload: JSON.stringify(payload) });
}
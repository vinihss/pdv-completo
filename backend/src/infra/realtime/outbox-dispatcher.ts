import { eq } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { outboxEvents } from "../db/schema.js";
import { wsGateway } from "./ws-gateway.js";

const POLL_MS = 200;

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
 */
export async function pollOutboxOnce() {
  const pending = await db.query.outboxEvents.findMany({
    where: eq(outboxEvents.published, false),
    limit: 50,
  } as any);

  for (const evt of pending) {
    try {
      wsGateway.broadcastToRoom(evt.room, {
        type: evt.eventType,
        payload: JSON.parse(evt.payload),
      });
      await db.update(outboxEvents).set({ published: true }).where(eq(outboxEvents.id, evt.id));
    } catch (err) {
      console.warn(`[outbox] descartando evento ${evt.id} (${evt.eventType}) com payload corrompido:`, err);
      await db.update(outboxEvents).set({ published: true }).where(eq(outboxEvents.id, evt.id));
    }
  }
}

/**
 * Grava um evento no outbox — chamar DENTRO da mesma transação que persiste
 * o dado principal, sempre com `await` (ver nota em infra/audit-log.ts).
 */
export async function enqueueEvent(tx: Tx, room: string, eventType: string, payload: unknown): Promise<void> {
  await tx.insert(outboxEvents).values({ room, eventType, payload: JSON.stringify(payload) });
}
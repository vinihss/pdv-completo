import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
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
  const timer = setInterval(async () => {
    const pending = await db.query.outboxEvents.findMany({
      where: eq(outboxEvents.published, false),
      limit: 50,
    } as any);

    for (const evt of pending) {
      wsGateway.broadcastToRoom(evt.room, {
        type: evt.eventType,
        payload: JSON.parse(evt.payload),
      });
      await db.update(outboxEvents).set({ published: true }).where(eq(outboxEvents.id, evt.id));
    }
  }, POLL_MS);

  return () => clearInterval(timer);
}

/**
 * Grava um evento no outbox — chamar dentro da mesma transação que persiste
 * o dado principal. Síncrona (ver nota em infra/audit-log.ts).
 */
export function enqueueEvent(tx: any, room: string, eventType: string, payload: unknown) {
  tx.insert(outboxEvents).values({ room, eventType, payload: JSON.stringify(payload) }).run();
}

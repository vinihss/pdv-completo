import { and, eq, lt } from "drizzle-orm";
import { db } from "./db/client.js";
import { outboxEvents, idempotencyKeys } from "./db/schema.js";

const INTERVAL_MS = 5 * 60_000;
const OUTBOX_RETENTION_MS = 60 * 60_000; // publicados ficam 1h pra auditoria/debug

/**
 * 2.5 — evita crescimento ilimitado das tabelas de infraestrutura:
 * - `outbox_event` publicados além da janela de retenção (já entregues, sem valor);
 * - `idempotency_key` com `expires_at` no passado (a janela de idempotência
 *   expirou; uma nova chamada com o mesmo correlationId deve poder reprocessar,
 *   ver idempotency.middleware.ts).
 */
export async function runMaintenanceOnce() {
  const outboxCutoff = new Date(Date.now() - OUTBOX_RETENTION_MS).toISOString();
  const purgeOutbox = await db
    .delete(outboxEvents)
    .where(and(eq(outboxEvents.published, true), lt(outboxEvents.createdAt, outboxCutoff)))
    .run();

  const nowIso = new Date().toISOString();
  const purgeKeys = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, nowIso)).run();

  return { outbox: purgeOutbox.changes, idempotencyKeys: purgeKeys.changes };
}

export function startMaintenanceJobs() {
  const timer = setInterval(() => {
    runMaintenanceOnce().catch((err) => {
      console.error("[maintenance] erro no ciclo de limpeza:", err);
    });
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}
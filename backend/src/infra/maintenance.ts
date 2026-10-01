import { and, eq, lt } from "drizzle-orm";
import { outboxEvents, idempotencyKeys, customerCarts, alerts } from "./db/schema.js";
import { LOCKS, tryWithAdvisoryLock } from "./locks.js";

const INTERVAL_MS = 5 * 60_000;
const OUTBOX_RETENTION_MS = 60 * 60_000; // publicados ficam 1h pra auditoria/debug
// A central de alertas é a única dessas tabelas que alguém realmente lê (o sino
// mostra o histórico), então a janela é longa: 7 dias dão para o gerente
// conferir "ontem chegou isso e ninguém pegou" depois do turno.
const ALERT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * 2.5 — evita crescimento ilimitado das tabelas de infraestrutura:
 * - `outbox_event` publicados além da janela de retenção (já entregues, sem valor);
 * - `idempotency_key` com `expires_at` no passado (a janela de idempotência
 *   expirou; uma nova chamada com o mesmo correlationId deve poder reprocessar,
 *   ver idempotency.middleware.ts);
 * - `customer_cart` com `expires_at` no passado (carrinho server-side
 *   abandonado — cart.usecases.ts);
 * - `alert` além da janela de retenção (o sino mostra o que chegou, não a
 *   arqueologia do mês passado — alert.usecases.ts).
 *
 * O ciclo roda inteiro dentro do advisory lock de transação
 * (`pdv:maintenance:owner`, ver infra/locks.ts): se outro processo já está
 * limpando, este ciclo pula em silêncio. A limpeza também fica atômica —
 * antes as quatro purgas eram transações implícitas separadas, então uma
 * queda no meio deixava o outbox já purgado com as idempotency_keys
 * intactas (o inverso do que importa não é um problema, mas o meio
 * caminho é; agora ou limpa tudo ou não limpa nada).
 */
export async function runMaintenanceOnce() {
  const attempt = await tryWithAdvisoryLock(LOCKS.maintenance, async (tx) => {
    const outboxCutoff = new Date(Date.now() - OUTBOX_RETENTION_MS).toISOString();
    // node-postgres devolve { rowCount } no lugar do { changes } do better-sqlite3
    // (que era `changes`, não `rowCount`, por isso a troca explícita aqui).
    const purgeOutbox = await tx
      .delete(outboxEvents)
      .where(and(eq(outboxEvents.published, true), lt(outboxEvents.createdAt, outboxCutoff)));

    const nowIso = new Date().toISOString();
    const purgeKeys = await tx.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, nowIso));

    const purgeCarts = await tx.delete(customerCarts).where(lt(customerCarts.expiresAt, nowIso));

    const alertCutoff = new Date(Date.now() - ALERT_RETENTION_MS).toISOString();
    const purgeAlerts = await tx.delete(alerts).where(lt(alerts.createdAt, alertCutoff));

    return {
      outbox: purgeOutbox.rowCount ?? 0,
      idempotencyKeys: purgeKeys.rowCount ?? 0,
      customerCarts: purgeCarts.rowCount ?? 0,
      alerts: purgeAlerts.rowCount ?? 0,
    };
  });

  // Lock ocupado: nada foi purgado, e a contagem é zero. Réplica não-eleita
  // não é erro — o ciclo de 5min da outra instância cobre o serviço.
  return attempt.acquired ? attempt.value : { outbox: 0, idempotencyKeys: 0, customerCarts: 0, alerts: 0 };
}

export function startMaintenanceJobs() {
  const timer = setInterval(() => {
    runMaintenanceOnce().catch((err) => {
      console.error("[maintenance] erro no ciclo de limpeza:", err);
    });
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}
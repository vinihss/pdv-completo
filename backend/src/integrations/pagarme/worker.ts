import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { paymentEvents } from "../../infra/db/schema.js";
import { runInTenantScope } from "../../infra/db/tenant-context.js";
import { LOCKS, tryWithAdvisoryLock } from "../../infra/locks.js";
import { listActiveTenants } from "../../infra/tenant/registry.js";
import {
  processPaymentEventUsecase,
  reconcilePendingPaymentsUsecase,
  requeueFailedEventUsecase,
} from "../../application/payment/payment.usecases.js";
import { isPagarmeEnabled, pagarmeConfig } from "./config.js";

// Consumidor da inbox de webhook do Pagar.me + reconciliação.
//
// ## Por que não há RabbitMQ aqui
//
// A spec §23 pedia exchange/queues/DLQ. Este repo não tem broker, o deploy é
// blue/green e o resultado da fila é justamente a tabela `payment_event`, que o
// endpoint já grava ANTES do 200. Um broker aqui seria uma dependência de infra
// nova para consumersar uma fila que o Postgres já é. O que a spec pede — evento
// persistido antes do processamento, processamento assíncrono, retry, DLQ — está
// todo aqui:
//
//   - persistido antes: gravado no POST do webhook, antes do 200;
//   - assíncrono: este ciclo, separado da requisição;
//   - retry: `attempts` + `next_attempt_at` com backoff. Um evento reenfileirado
//     fica `failed` com `next_attempt_at` no futuro: o drain só o pega quando a
//     data vence, e é o `attempts` que fecha a porta depois de 5 tentativas;
//   - DLQ: evento que estourou o teto fica em `failed` sem `next_attempt_at` —
//     sai da fila e fica parado, à vista, sem ser reprocessado. A reconciliação
//     assume a recuperação dele.
//
// ## Cadência
//
// A inbox drena a cada 2s (um webhook de pagamento é evento de baixa frequência
// por natureza: o pico é o fechamento do expediente) e a reconciliação a cada
// `PAGARME_RECONCILIATION_INTERVAL_MS` (10min por padrão, spec §22).
const WEBHOOK_POLL_MS = 2000;
const BATCH = 25;

let webhookTimer: NodeJS.Timeout | null = null;
let reconciliationTimer: NodeJS.Timeout | null = null;
let webhookRunning = false;

export function startPagarmeWorkers(): { stop: () => void } {
  if (!isPagarmeEnabled()) {
    // Mesmo comportamento do worker do iFood: instalar sem credencial não é
    // erro, é uma instalação que não usa o módulo.
    console.log("[pagarme] integração desabilitada (PAGARME_ENABLED=false e/ou sem PAGARME_SECRET_KEY) — workers não iniciados");
    return { stop: () => {} };
  }

  const tickWebhook = async () => {
    // Por processo: evita o ciclo se sobrepor a si mesmo. Contra outra
    // instância apontada pro mesmo banco é o advisory lock que serializa.
    if (webhookRunning) return;
    webhookRunning = true;
    try {
      // Itera sobre todos os tenants ativos e roda o drain dentro do escopo
      // de cada um. Erros em um tenant não derrubam o processamento dos outros.
      const tenants = await listActiveTenants();
      for (const tenant of tenants) {
        try {
          await runInTenantScope(
            { schemaName: tenant.schemaName, slug: tenant.slug, isDefault: false },
            async () => {
              // Verifica se Pagar.me está habilitado globalmente (o isPagarmeEnabled
              // lê do config de env, não é por-tenant ainda). Se desabilitado,
              // pula este tenant sem adquirir lock.
              if (!isPagarmeEnabled()) return;
              await tryWithAdvisoryLock(LOCKS.paymentWorker, () => drainInboxOnce());
            }
          );
        } catch (err) {
          // Erro de um tenant não derruba os outros — loga e continua.
          console.error(`[pagarme] erro ao processar tenant ${tenant.slug} na inbox:`, err);
        }
      }
    } catch (err) {
      // Um erro de ciclo não pode derrubar o processo (regra 1.5). O
      // `tryWithAdvisoryLock` abre uma transação, então banco fora rejeita em
      // TODO ciclo — sem este catch seria unhandled rejection.
      console.error("[pagarme] erro no ciclo da inbox:", err);
    } finally {
      webhookRunning = false;
    }
  };

  const tickReconciliation = async () => {
    try {
      // Itera sobre todos os tenants ativos e roda a reconciliação dentro do
      // escopo de cada um. Erros em um tenant não derrubam o processamento dos outros.
      const tenants = await listActiveTenants();
      for (const tenant of tenants) {
        try {
          await runInTenantScope(
            { schemaName: tenant.schemaName, slug: tenant.slug, isDefault: false },
            async () => {
              // Verifica se Pagar.me está habilitado globalmente. Se desabilitado,
              // pula este tenant sem adquirir lock.
              if (!isPagarmeEnabled()) return;
              await tryWithAdvisoryLock(LOCKS.paymentReconciliation, () => reconcilePendingPaymentsUsecase());
            }
          );
        } catch (err) {
          // Erro de um tenant não derruba os outros — loga e continua.
          console.error(`[pagarme] erro ao processar tenant ${tenant.slug} na reconciliação:`, err);
        }
      }
    } catch (err) {
      console.error("[pagarme] erro no ciclo de reconciliação:", err);
    }
  };

  void tickWebhook();
  webhookTimer = setInterval(tickWebhook, WEBHOOK_POLL_MS);
  void tickReconciliation();
  reconciliationTimer = setInterval(tickReconciliation, pagarmeConfig.reconciliationIntervalMs);

  return {
    stop: () => {
      if (webhookTimer) clearInterval(webhookTimer);
      if (reconciliationTimer) clearInterval(reconciliationTimer);
      webhookTimer = null;
      reconciliationTimer = null;
    },
  };
}

/**
 * Um ciclo da inbox: pega os eventos elegíveis e processa um a um.
 *
 * Elegível = `received` (novo, sem `next_attempt_at`) ou `failed` com
 * `next_attempt_at` vencido. Repare que o estado reenfileirado é `failed`, e
 * não `received`: é o `next_attempt_at` que diz se a linha está esperando o
 * backoff (preenchido) ou se é DLQ (NULL). `processing` fica de fora de
 * propósito: um evento marcado como em processamento que o processo não
 * terminou é resgatado pela reconciliação, e pegá-lo aqui criaria dois
 * consumidores da mesma linha ao mesmo tempo.
 */
export async function drainInboxOnce(limit = BATCH): Promise<number> {
  const agora = new Date().toISOString();

  const pendentes = await db.query.paymentEvents.findMany({
    where: and(
      or(
        and(eq(paymentEvents.status, "received"), isNull(paymentEvents.nextAttemptAt)),
        and(eq(paymentEvents.status, "failed"), lte(paymentEvents.nextAttemptAt, agora)),
      ),
    ),
    orderBy: (t, { asc }) => [asc(t.seq)],
    limit,
  });

  for (const event of pendentes) {
    try {
      await processPaymentEventUsecase(event.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Reenfileira com backoff, ou abandona se estourou o teto (aí fica em
      // `failed` sem `next_attempt_at` = DLQ). Um evento que quebra no código
      // quebraria em todo retry; o que o resolve é a reconciliação relendo o
      // gateway por `GET /orders/{id}`.
      await requeueFailedEventUsecase(event.id, message).catch(() => undefined);
    }
  }

  return pendentes.length;
}

/** Helper de teste: quantos eventos estão presos na DLQ. */
export async function countDeadLetteredEvents(): Promise<number> {
  const rows = await db.query.paymentEvents.findMany({
    where: and(eq(paymentEvents.status, "failed"), isNull(paymentEvents.nextAttemptAt)),
  });
  return rows.length;
}
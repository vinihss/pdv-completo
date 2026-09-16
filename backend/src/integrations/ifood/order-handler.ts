import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { ifoodEvents, orders } from "../../infra/db/schema.js";
import { ifoodConfig } from "./config.js";
import { ifoodFetch } from "./client.js";
import { ingestIfoodOrder } from "./ingest.js";
import { concludeIfoodOrder, cancelIfoodOrder } from "./status-pushback.js";
import type { IfoodEvent, IfoodOrder } from "./order.types.js";

// Razão usada para cancelar pedido cujo SKU não casa com o cardápio local.
// O catálogo de razões é dinâmico (GET /orders/:id/cancellationReasons) —
// preciso validar o código na homologação (docs/06-ifood-integration.md).
const CANCEL_REASON_PRODUCT_UNAVAILABLE = "501";

/**
 * Processa UM evento da fila de polling. Regra do iFood: persistir o evento
 * localmente ANTES de confirmar leitura (ACK) — eventos não ackados re-entre
 * no próximo poll. Retorna "acked" apenas quando o evento pôde ser tratado
 * definitivamente (o worker confirma a leitura em batch no fim do ciclo).
 *
 * Status possíveis na tabela ifood_event:
 * - processed: ingerido/confirmado, aguardando ACK do worker;
 * - ignored:   tratado com intenção (ex.: SKU desconhecido → cancelado aqui),
 *              sem ação local — ainda precisa de ACK;
 * - failed:    erro transitório (rede/API) — NÃO ackar, retenta no próximo poll.
 */
export async function handleIfoodOrderEvent(ev: IfoodEvent): Promise<"acked" | "failed"> {
  const existing = await db.query.ifoodEvents.findFirst({ where: eq(ifoodEvents.id, ev.id) });
  if (!existing) {
    db.insert(ifoodEvents)
      .values({ id: ev.id, orderRef: ev.orderId, code: ev.code, fullCode: ev.fullCode ?? null, raw: JSON.stringify(ev) })
      .run();
  }
  // Já tratado e ackado: dedupe.
  if (existing?.status === "acked") return "acked";

  try {
    if (ev.code === "CONFIRMED") {
      return await handleConfirmed(ev);
    }
    // Retorno de status (Etapa C) — transições locais da comanda a partir do
    // evento. CONCLUDED fecha (pagamento + itens delivered); CANCELLED/STALE/
    // CANCELLATION_REQUESTED encerram como canceladas. Demais códigos
    // (DISPATCHED, READY_TO_PICKUP...) reconhecidos mas sem ação local.
    const handled = routeStatusEvent(ev);
    mark(ev.id, handled ? "processed" : "ignored");
    return "acked";
  } catch (err) {
    mark(ev.id, "failed");
    console.error(`[ifood] falha ao processar evento ${ev.code} ${ev.id}:`, (err as Error).message);
    return "failed";
  }
}

// Não lança para o mundo externo (devolve void) — tratado aqui por ser
// síncrono e não depender de rede. Retorna false quando o código é apenas
// informativo (sem transição local).
function routeStatusEvent(ev: IfoodEvent): boolean {
  switch (ev.code) {
    case "CONCLUDED":
      return concludeIfoodOrder(ev.orderId);
    case "CANCELLED":
    case "STALE":
      return cancelIfoodOrder(ev.orderId, `cancelado pelo iFood (${ev.code})`);
    case "CANCELLATION_REQUESTED":
      // Cliente pediu cancelamento: aceita (best-effort) e encerra local.
      void ifoodFetch(ifoodConfig.orderUrl(`/orders/${ev.orderId}/acceptCancellation`), {
        method: "POST",
        body: { accept: true },
      }).catch(() => {});
      return cancelIfoodOrder(ev.orderId, "cancelamento solicitado pelo cliente");
    default:
      return false;
  }
}

async function handleConfirmed(ev: IfoodEvent): Promise<"acked" | "failed"> {
  // Idempotência: comanda local já vinculada a este orderId do iFood (índice
  // único de external_ref, 0009). Casos: reentrega de evento após ACK perdido
  // ou re-processamento após falha no confirm — NÃO criar outra comanda, mas
  // sim re-tentar o confirm (idempotente no iFood) até completar.
  const existingLocal = await db.query.orders.findFirst({ where: eq(orders.externalRef, ev.orderId) });
  if (existingLocal) {
    const confirmed = await confirmIfPossible(ev.orderId);
    mark(ev.id, confirmed ? "processed" : "failed");
    return confirmed ? "acked" : "failed";
  }

  const order = await ifoodFetch<IfoodOrder>(ifoodConfig.orderUrl(`/orders/${ev.orderId}`));
  if (!order) {
    throw new Error(`GET /orders/${ev.orderId} sem corpo`);
  }

  const result = await ingestIfoodOrder(order);

  if (!result.ok) {
    // SKU(s) desconhecidos ou sem itens: não confirmar pedido que não vamos
    // cumprir. Avisa o iFood (pode estar no 8-min window) e ack.
    await requestCancellationIfPossible(ev.orderId);
    mark(ev.id, "ignored");
    console.warn(
      `[ifood] pedido ${ev.orderId} não ingerido (${result.reason}):`,
      JSON.stringify(result.details ?? {}),
    );
    return "acked";
  }

  // Confirmar dentro dos 8 minutos — sem isso o iFood cancela sozinho. Se a
  // chamada falhar, fica com a comanda aberta e volta a tentar no próximo poll
  // (o existingLocal acima reconhece e re-confirma).
  const confirmed = await confirmIfPossible(ev.orderId);
  mark(ev.id, confirmed ? "processed" : "failed");
  return confirmed ? "acked" : "failed";
}

// POST /orders/{id}/confirm é idempotente no iFood (chamadas duplicadas
// ignoradas). Erros transitórios (5xx/429) disparam retry no próximo poll.
async function confirmIfPossible(orderId: string): Promise<boolean> {
  try {
    await ifoodFetch(ifoodConfig.orderUrl(`/orders/${orderId}/confirm`), { method: "POST", body: {} });
    return true;
  } catch (err) {
    console.error(`[ifood] confirm de ${orderId} falhou:`, (err as Error).message);
    return false;
  }
}

// Melhor esforço — se o cancelamento falhar, o iFood cancela sozinho em 8 min.
async function requestCancellationIfPossible(orderId: string): Promise<void> {
  try {
    await ifoodFetch(ifoodConfig.orderUrl(`/orders/${orderId}/requestCancellation`), {
      method: "POST",
      body: { reason: CANCEL_REASON_PRODUCT_UNAVAILABLE },
    });
  } catch (err) {
    console.warn(`[ifood] requestCancellation de ${orderId} falhou:`, (err as Error).message);
  }
}

function mark(id: string, status: "processed" | "ignored" | "failed") {
  db.update(ifoodEvents)
    .set({ status, processedAt: new Date().toISOString() })
    .where(eq(ifoodEvents.id, id))
    .run();
}
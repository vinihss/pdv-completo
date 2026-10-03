import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { orders, orderItems, orderPayments, deliveries, storeSettings } from "../../infra/db/schema.js";
import { DEFAULT_STORE_ID, SYSTEM_USER_ID } from "../../domain/constants.js";
import { round2 } from "../../domain/money.js";
import { Errors } from "../../domain/errors.js";
import { canTransitionDelivery } from "../../domain/customer-order-state.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

// Retorno de status do iFood → ciclo de vida local da comanda. O iFood é a
// fonte da verdade do pedido externo: CANCELLED/STALE encerram sem venda,
// CONCLUDED fecha com pagamento. Como pedidos iFood não têm garçom nem
// "entrega" no sentido do balcão, aqui forçamos os itens a delivered (quando
// aplicável) para destravar o fechamento sem depender de interação manual.

type IfoodPaymentMethod = string;

// Mapeia o método de pagamento do iFood para o enum local. iFood usa: CASH,
// CARD, PIX, ONLINE (digital/wallet), CREDIT/DEBIT, e PAYMENT_METHOD_ONLINE.
function mapPaymentMethod(method: string | undefined): "cash" | "card" | "pix" | "other" {
  switch ((method ?? "").toUpperCase()) {
    case "CASH":
    case "MONEY":
      return "cash";
    case "PIX":
      return "pix";
    case "CARD":
    case "CREDIT":
    case "DEBIT":
    case "CARD_MACHINE":
      return "card";
    default:
      return "other"; // ONLINE e qualquer coisa não mapeada caem em "outros"
  }
}

// Guarda a opção de pagamento mais adequada respeitando os métodos habilitados
// nas store_settings. Se nada for habilitado, retorna null (não registra e
// loga — a comanda fica para o gerente fechar manualmente).
function pickPaymentMethod(
  ifoodMethods: Array<{ method?: string; type?: string }>,
  enabled: string[]
): { method: "cash" | "card" | "pix" | "other"; confirmed: boolean } | null {
  const mapped = ifoodMethods.map((p) => mapPaymentMethod(p.method ?? p.type));
  for (const m of ["cash", "card", "pix", "other"] as const) {
    if (mapped.includes(m) && enabled.includes(m)) {
      return { method: m, confirmed: true };
    }
  }
  // Nenhum método do pedido está habilitado localmente — tenta "other" como
  // último recurso (sempre aprovado no CONCLUDED, o dinheiro já passou).
  if (enabled.includes("other")) return { method: "other", confirmed: true };
  return null;
}

// CONCLUDED: pago + entregue. Fecha a comanda local (itens → delivered,
// pagamento registrado, delivery concluída). Retorna false se a comanda não
// existir (evita duplicidade/ruído) ou se não houver pagamento habilitado.
export async function concludeIfoodOrder(orderRef: string): Promise<boolean> {
  const order = await db.query.orders.findFirst({ where: eq(orders.externalRef, orderRef) });
  if (!order || order.channel !== "ifood" || order.status !== "open") return false;

  // Settings por tenant (0011). O `order.store_id` existe na tabela (0008)
  // mas ainda não está no model do Drizzle nem é gravado no INSERT — enquanto
  // isso não acontecer, o iFood (integração single-store, config global) lê as
  // settings da store default.
  const settings = await db.query.storeSettings.findFirst({
    where: eq(storeSettings.storeId, DEFAULT_STORE_ID),
  });
  const enabled: string[] = settings ? JSON.parse(settings.enabledPaymentMethods) : [];
  const ifoodPayments: Array<{ method?: string; type?: string }> = order.ifoodPayments
    ? JSON.parse(order.ifoodPayments)
    : [];
  const payment = pickPaymentMethod(ifoodPayments, enabled);

  await db.transaction(async (tx) => {
    // Garante que itens pendentes não bloqueiam o fechamento (a entrega já
    // aconteceu do lado do iFood — a comanda é só registro contábil).
    await tx.update(orderItems)
      .set({ status: "delivered" })
      .where(and(eq(orderItems.orderId, order.id), notInArray(orderItems.status, ["delivered", "cancelled"])))
      ;

    if (payment) {
      // Pagamento já recebido pelo iFood — grava como linha de pagamento
      // confirmada cobrindo o total da comanda (snapshot unit_price + taxa).
      // unit_price e quantity são real/integer: o produto no Postgres é
      // double precision, então SUM devolve number (não string de bigint).
      const [sumRow] = await tx
        .select({ sum: sql<number>`COALESCE(SUM(${orderItems.unitPrice} * ${orderItems.quantity}), 0)` })
        .from(orderItems)
        .where(and(eq(orderItems.orderId, order.id), notInArray(orderItems.status, ["cancelled"])));
      const itemSum = sumRow?.sum ?? 0;
      const total = round2(Number(itemSum) + (order.deliveryFee ?? 0));
      await tx.insert(orderPayments)
        .values({
          orderId: order.id,
          method: payment.method,
          amount: total,
          received: payment.method === "cash" ? total : null,
          confirmed: true,
          confirmedAt: new Date().toISOString(),
          confirmedBy: SYSTEM_USER_ID,
          createdBy: SYSTEM_USER_ID,
        })
        ;

      await tx.update(orders)
        .set({
          paymentMethod: payment.method,
          paymentConfirmedAt: new Date().toISOString(),
          paymentConfirmedBy: SYSTEM_USER_ID,
        })
        .where(eq(orders.id, order.id))
        ;
    }

    await tx.update(orders)
      .set({ status: "closed", closedAt: new Date().toISOString() })
      .where(eq(orders.id, order.id))
      ;

    const delivery = await tx.query.deliveries.findFirst({ where: eq(deliveries.orderId, order.id) });
    if (delivery && delivery.status !== "delivered") {
      await tx.update(deliveries).set({ status: "delivered" }).where(eq(deliveries.id, delivery.id));
    }

    await enqueueEvent(tx, "deliveries", "ifood.order.concluded", { orderId: order.id, externalRef: orderRef });
    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.closed", {
      orderId: order.id,
      tableId: order.tableId,
    });
    await logAction(tx, SYSTEM_USER_ID, "ifood_order_concluded", order.id, {
      externalRef: orderRef,
      paymentMethod: payment?.method ?? null,
      reason: payment ? null : "sem método habilitado — gerente encerra manualmente",
    });
  });
  return true;
}

// CANCELLED / STALE / CANCELLATION_REQUESTED: o pedido não vira venda.
// Encerra a comanda local como cancelada (idempotente: se já não está "open",
// não faz nada e devolve true — o ACK segue normal).
export async function cancelIfoodOrder(orderRef: string, reason: string): Promise<boolean> {
  const order = await db.query.orders.findFirst({ where: eq(orders.externalRef, orderRef) });
  if (!order || order.channel !== "ifood" || order.status !== "open") return false;

  await db.transaction(async (tx) => {
    await tx.update(orderItems)
      .set({ status: "cancelled" })
      .where(and(eq(orderItems.orderId, order.id), notInArray(orderItems.status, ["delivered", "cancelled"])))
      ;

    await tx.update(orders)
      .set({ status: "cancelled", closedAt: new Date().toISOString(), cancelReason: reason })
      .where(eq(orders.id, order.id))
      ;

    // 0018: cancelamento (iFood é a fonte da verdade) vira "cancelled" —
    // distinto de "failed" ("problema na entrega"); transições válidas na
    // máquina declarativa (customer-order-state.ts).
    const delivery = await tx.query.deliveries.findFirst({ where: eq(deliveries.orderId, order.id) });
    if (delivery && delivery.status !== "delivered" && canTransitionDelivery(delivery.status, "cancelled")) {
      await tx.update(deliveries).set({ status: "cancelled" }).where(eq(deliveries.id, delivery.id));
    }

    await enqueueEvent(tx, "deliveries", "ifood.order.cancelled", { orderId: order.id, externalRef: orderRef, reason });
    await enqueueEvent(tx, `table:${order.tableId ?? order.id}`, "order.cancelled", {
      orderId: order.id,
      tableId: order.tableId,
    });
    await logAction(tx, SYSTEM_USER_ID, "ifood_order_cancelled", order.id, { externalRef: orderRef, reason });
  });
  return true;
}

export { Errors, type IfoodPaymentMethod };
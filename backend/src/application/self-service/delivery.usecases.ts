import { eq, inArray, and } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { deliveries, users, orders, customers } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { canTransitionDelivery, type DeliveryStatus } from "../../domain/customer-order-state.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { createAlertTx, DELIVERY_ASSIGNED_ALERT_KIND, describeDeliveryAssignedAlert } from "../alert/alert.usecases.js";
import { emitCustomerStageChangedTx } from "./customer-stage.js";
import { closeOrderAfterDelivery } from "./manager-delivery-status.usecase.js";
import { notifyDispatched, notifyDelivered, notifyFailed } from "../../integrations/whatsapp/whatsapp.notifier.js";
import { printCourierOrder } from "../../integrations/printer/printer.usecases.js";
import { getSettings } from "../order/order.usecases.js";

const DELIVERY_ROOM = "deliveries";

function serialize(d: typeof deliveries.$inferSelect) {
  return {
    id: d.id,
    orderId: d.orderId,
    courierId: d.courierId,
    address: d.address,
    status: d.status,
    // A lista é ordenada por isto, mas a coluna não saía na resposta — a tela
    // de entregas ficava sem nenhuma noção de idade do pedido.
    createdAt: d.createdAt,
    dispatchedAt: d.dispatchedAt,
    deliveredAt: d.deliveredAt,
    notes: d.notes,
  };
}

async function getOwnedDelivery(deliveryId: string, courierId: string) {
  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.id, deliveryId) });
  if (!delivery) throw Errors.notFound("Entrega");
  if (delivery.courierId !== courierId) throw Errors.forbiddenRole();
  return delivery;
}

// Nome de quem pediu. A fonte é o `customer` ligado à comanda; o `tabLabel` é
// só a rede de segurança para o pedido que entrou sem cliente vinculado — o
// checkout self-service grava `tabLabel: "Delivery - <nome>"`
// (order-intake.usecase.ts). O prefixo é exigido de propósito: sem ele o
// fallback devolveria qualquer rótulo solto como se fosse nome de gente.
const DELIVERY_TAB_PREFIX = /^delivery\s*-\s*/i;

function customerNameFor(
  order: { customerId: string | null; tabLabel: string | null } | undefined,
  nameByCustomerId: Map<string, string>
): string | null {
  if (!order) return null;
  if (order.customerId) {
    const name = nameByCustomerId.get(order.customerId);
    if (name) return name;
  }
  if (order.tabLabel && DELIVERY_TAB_PREFIX.test(order.tabLabel))
    return order.tabLabel.replace(DELIVERY_TAB_PREFIX, "");
  return null;
}

// ---------- GET /courier/deliveries ----------
export async function listCourierDeliveriesUsecase(input: {
  courierId: string;
  statuses?: DeliveryStatus[];
}) {
  const rows = await db.query.deliveries.findMany({
    where: (d, { and, eq: eqOp }) =>
      and(
        eqOp(d.courierId, input.courierId),
        input.statuses?.length ? inArray(d.status, input.statuses) : undefined
      ),
    orderBy: (d, { asc }) => asc(d.createdAt),
  });
  return rows.map(serialize);
}

// ---------- PATCH /courier/deliveries/:id/dispatch ----------
export async function dispatchDeliveryUsecase(input: { deliveryId: string; courierId: string }) {
  const delivery = await getOwnedDelivery(input.deliveryId, input.courierId);
  // Transição validada pela máquina declarativa (customer-order-state.ts) —
  // regra única compartilhada com deliver/fail/cancelamento.
  if (!canTransitionDelivery(delivery.status, "out_for_delivery"))
    throw Errors.invalidDeliveryTransition("Entrega não está aguardando entregador.");

  const updated = await db.transaction(async (tx) => {
    const [result] = await tx
      .update(deliveries)
      .set({ status: "out_for_delivery", dispatchedAt: new Date().toISOString() })
      .where(eq(deliveries.id, input.deliveryId))
      .returning();
    await enqueueEvent(tx, DELIVERY_ROOM, "delivery.status_changed", serialize(result));
    await emitCustomerStageChangedTx(tx, result.orderId);
    await logAction(tx, input.courierId, "delivery_dispatched", result.orderId, {});
    return result;
  });

  notifyDispatched(updated.orderId).catch((err) => console.error("falha ao notificar saída pro cliente:", err));

  // Impressão automática do courier (pós-commit, fire-and-forget).
  try {
    const settings = await getSettings();
    if (settings.printerEnabled && settings.printerAutoPrint) {
      printCourierOrder(updated.orderId).catch((err) => console.error("falha ao imprimir comanda no courier:", err));
    }
  } catch (err) {
    console.error("falha ao verificar flags de impressão:", err);
  }

  return serialize(updated);
}

// ---------- PATCH /courier/deliveries/:id/deliver ----------
export async function deliverDeliveryUsecase(input: { deliveryId: string; courierId: string }) {
  const delivery = await getOwnedDelivery(input.deliveryId, input.courierId);
  if (!canTransitionDelivery(delivery.status, "delivered"))
    throw Errors.invalidDeliveryTransition("Entrega não está em trânsito.");

  const updated = await db.transaction(async (tx) => {
    const [result] = await tx
      .update(deliveries)
      .set({ status: "delivered", deliveredAt: new Date().toISOString() })
      .where(eq(deliveries.id, input.deliveryId))
      .returning();
    await enqueueEvent(tx, DELIVERY_ROOM, "delivery.status_changed", serialize(result));
    await emitCustomerStageChangedTx(tx, result.orderId);
    // Notificação WhatsApp de status: disparo real fica pra quando
    // whatsapp.notifier.ts existir (fora do escopo desta etapa) — aqui só
    // fica registrado no outbox como evento consumível por esse worker depois.
    await enqueueEvent(tx, `order:${result.orderId}`, "delivery.delivered", { orderId: result.orderId });
    await logAction(tx, input.courierId, "delivery_completed", result.orderId, {});
    return result;
  });

  // Fecha o pedido de verdade — sem isso ele fica preso em "open" pra sempre,
  // porque order_item nunca chega a "delivered" numa entrega (não há garçom
  // servindo mesa) e closeOrderUsecase exige isso + paymentMethod registrado.
  //
  // Compartilhado com `setDeliveryStatusUsecase` (gerente marcando entregue
  // pelo balcão): os dois precisam do mesmo efeito, e duas cópias divergem
  // no primeiro conserto de uma delas. O comentário de lá explica o porquê.
  await closeOrderAfterDelivery(updated.orderId, input.courierId);

  notifyDelivered(updated.orderId).catch((err) => console.error("falha ao notificar entrega concluída pro cliente:", err));

  return serialize(updated);
}

// ---------- PATCH /courier/deliveries/:id/fail ----------
export async function failDeliveryUsecase(input: { deliveryId: string; courierId: string; reason: string }) {
  const delivery = await getOwnedDelivery(input.deliveryId, input.courierId);
  if (!canTransitionDelivery(delivery.status, "failed"))
    throw Errors.invalidDeliveryTransition("Entrega não está em trânsito.");

  const updated = await db.transaction(async (tx) => {
    const [result] = await tx
      .update(deliveries)
      .set({ status: "failed", notes: input.reason })
      .where(eq(deliveries.id, input.deliveryId))
      .returning();
    await enqueueEvent(tx, DELIVERY_ROOM, "delivery.status_changed", serialize(result));
    await emitCustomerStageChangedTx(tx, result.orderId);
    await logAction(tx, input.courierId, "delivery_failed", result.orderId, { reason: input.reason });
    return result;
  });

  notifyFailed(updated.orderId, input.reason).catch((err) => console.error("falha ao notificar problema na entrega pro cliente:", err));

  return serialize(updated);
}

// ---------- GET /manager/deliveries ----------
export async function listManagerDeliveriesUsecase(input: { statuses?: DeliveryStatus[] }) {
  const rows = await db.query.deliveries.findMany({
    where: input.statuses?.length ? inArray(deliveries.status, input.statuses) : undefined,
    // Do mais novo pro mais antigo: quem gerencia entrega precisa ver primeiro
    // o que acabou de cair. (A lista do entregador continua em ASC de propósito
    // — a fila dele é a mais antiga primeiro.)
    orderBy: (d, { desc }) => desc(d.createdAt),
  });

  const courierIds = [...new Set(rows.map((d) => d.courierId).filter((id): id is string => !!id))];
  const couriers = courierIds.length
    ? await db.query.users.findMany({ where: inArray(users.id, courierIds as string[]) })
    : [];
  const courierById = new Map(couriers.map((c) => [c.id, c]));

  // Nome do cliente, sem uma query por card: duas leituras em lote (comandas
  // das entregas, depois os clientes dessas comandas) resolvem a lista toda.
  const orderIds = [...new Set(rows.map((d) => d.orderId))];
  const orderRows = orderIds.length
    ? await db.query.orders.findMany({ where: inArray(orders.id, orderIds) })
    : [];
  const customerIds = [
    ...new Set(orderRows.map((o) => o.customerId).filter((id): id is string => !!id)),
  ];
  const customerRows = customerIds.length
    ? await db.query.customers.findMany({ where: inArray(customers.id, customerIds) })
    : [];
  const customerNameById = new Map(customerRows.map((c) => [c.id, c.name]));
  const orderById = new Map(orderRows.map((o) => [o.id, o]));

  return rows.map((d) => ({
    ...serialize(d),
    courier: d.courierId ? { id: d.courierId, name: (courierById.get(d.courierId) as any)?.name ?? null } : null,
    customerName: customerNameFor(orderById.get(d.orderId), customerNameById),
  }));
}

// ---------- PATCH /manager/deliveries/:id/assign ----------
export async function assignCourierUsecase(input: { deliveryId: string; courierId: string; managerId: string }) {
  const courier = await db.query.users.findFirst({ where: eq(users.id, input.courierId) });
  if (!courier || courier.role !== "courier") throw Errors.invalidCourierRole();

  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.id, input.deliveryId) });
  if (!delivery) throw Errors.notFound("Entrega");

  const updated = await db.transaction(async (tx) => {
    const [result] = await tx
      .update(deliveries)
      .set({ courierId: input.courierId })
      .where(eq(deliveries.id, input.deliveryId))
      .returning();
    // Atribuir não muda o status — continua awaiting_courier até o entregador
    // confirmar saída via dispatch (§05 "Endpoints do manager").
    await enqueueEvent(tx, DELIVERY_ROOM, "delivery.assigned", serialize(result));
    // O `delivery.assigned` vai para o room `deliveries`, que é de TODOS os
    // entregadores: ele serve para a tela recarregar, não para avisar. O aviso
    // é o alerta, e ele é DIRECIONADO — só o entregador que acabou de receber
    // a entrega ouve (audiência `user:<id>`, room `alerts:user:<id>`, ver
    // alert.usecases.ts). Adicionar `courier` à audiência global faria o sino
    // tocar para todos os entregadores a cada pedido, mesmo os que não são
    // deles; e o `ORDER_ALERT_AUDIENCE` continua manager/cashier/kitchen.
    const { title, body } = describeDeliveryAssignedAlert({
      orderId: result.orderId,
      address: result.address,
    });
    await createAlertTx(tx, {
      kind: DELIVERY_ASSIGNED_ALERT_KIND,
      title,
      body,
      orderId: result.orderId,
      // O destinatário é o `courierId` validado lá em cima (papel `courier`),
      // e não o que voltou no UPDATE — que o TS tipa como nulo por causa do
      // `ON DELETE SET NULL` da coluna. São o mesmo id.
      userIds: [input.courierId],
    });
    await logAction(tx, input.managerId, "delivery_assigned", result.orderId, { courierId: input.courierId });
    return result;
  });

  return serialize(updated);
}

// ---------- GET /manager/couriers ----------
export async function listCouriersUsecase() {
  const rows = await db.query.users.findMany({ where: eq(users.role, "courier") });
  return rows.map((u) => ({ id: u.id, name: u.name, active: u.active }));
}

import { eq, inArray, and, notInArray } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { deliveries, users, orders, orderItems } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { canTransitionDelivery, type DeliveryStatus } from "../../domain/customer-order-state.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { emitCustomerStageChangedTx } from "./customer-stage.js";
import { registerPaymentUsecase, closeOrderUsecase } from "../order/order.usecases.js";
import { notifyDispatched, notifyDelivered, notifyFailed } from "../../integrations/whatsapp/whatsapp.notifier.js";

const DELIVERY_ROOM = "deliveries";

function serialize(d: typeof deliveries.$inferSelect) {
  return {
    id: d.id,
    orderId: d.orderId,
    courierId: d.courierId,
    address: d.address,
    status: d.status,
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

  const updated = db.transaction((tx) => {
    const result = tx
      .update(deliveries)
      .set({ status: "out_for_delivery", dispatchedAt: new Date().toISOString() })
      .where(eq(deliveries.id, input.deliveryId))
      .returning()
      .get();
    enqueueEvent(tx, DELIVERY_ROOM, "delivery.status_changed", serialize(result));
    emitCustomerStageChangedTx(tx, result.orderId);
    logAction(tx, input.courierId, "delivery_dispatched", result.orderId, {});
    return result;
  });

  notifyDispatched(updated.orderId).catch((err) => console.error("falha ao notificar saída pro cliente:", err));

  return serialize(updated);
}

// ---------- PATCH /courier/deliveries/:id/deliver ----------
export async function deliverDeliveryUsecase(input: { deliveryId: string; courierId: string }) {
  const delivery = await getOwnedDelivery(input.deliveryId, input.courierId);
  if (!canTransitionDelivery(delivery.status, "delivered"))
    throw Errors.invalidDeliveryTransition("Entrega não está em trânsito.");

  const updated = db.transaction((tx) => {
    const result = tx
      .update(deliveries)
      .set({ status: "delivered", deliveredAt: new Date().toISOString() })
      .where(eq(deliveries.id, input.deliveryId))
      .returning()
      .get();
    enqueueEvent(tx, DELIVERY_ROOM, "delivery.status_changed", serialize(result));
    emitCustomerStageChangedTx(tx, result.orderId);
    // Notificação WhatsApp de status: disparo real fica pra quando
    // whatsapp.notifier.ts existir (fora do escopo desta etapa) — aqui só
    // fica registrado no outbox como evento consumível por esse worker depois.
    enqueueEvent(tx, `order:${result.orderId}`, "delivery.delivered", { orderId: result.orderId });
    logAction(tx, input.courierId, "delivery_completed", result.orderId, {});
    return result;
  });

  // Fecha o pedido de verdade — sem isso ele fica preso em "open" pra
  // sempre, porque order_item nunca chega a "delivered" numa entrega (não
  // há garçom servindo mesa) e closeOrderUsecase exige isso + paymentMethod
  // registrado. Cada chamada abaixo é atômica por conta própria (mesmo
  // padrão de composição sequencial já usado em createSelfServiceOrderUsecase),
  // não há uma transação única amarrando os três passos.
  await db
    .update(orderItems)
    .set({ status: "delivered" })
    .where(and(eq(orderItems.orderId, updated.orderId), notInArray(orderItems.status, ["delivered", "cancelled"])));

  const order = await db.query.orders.findFirst({ where: eq(orders.id, updated.orderId) });
  if (order?.paymentMethod) {
    // confirmed:true — o entregador recebeu o pagamento (dinheiro/pix) nesse
    // momento, diferente do registro inicial em createSelfServiceOrderUsecase
    // (confirmed:false lá, que era só a intenção declarada no checkout).
    await registerPaymentUsecase({ orderId: updated.orderId, userId: input.courierId, paymentMethod: order.paymentMethod, confirmed: true });
    await closeOrderUsecase({ orderId: updated.orderId, userId: input.courierId });
  }

  notifyDelivered(updated.orderId).catch((err) => console.error("falha ao notificar entrega concluída pro cliente:", err));

  return serialize(updated);
}

// ---------- PATCH /courier/deliveries/:id/fail ----------
export async function failDeliveryUsecase(input: { deliveryId: string; courierId: string; reason: string }) {
  const delivery = await getOwnedDelivery(input.deliveryId, input.courierId);
  if (!canTransitionDelivery(delivery.status, "failed"))
    throw Errors.invalidDeliveryTransition("Entrega não está em trânsito.");

  const updated = db.transaction((tx) => {
    const result = tx
      .update(deliveries)
      .set({ status: "failed", notes: input.reason })
      .where(eq(deliveries.id, input.deliveryId))
      .returning()
      .get();
    enqueueEvent(tx, DELIVERY_ROOM, "delivery.status_changed", serialize(result));
    emitCustomerStageChangedTx(tx, result.orderId);
    logAction(tx, input.courierId, "delivery_failed", result.orderId, { reason: input.reason });
    return result;
  });

  notifyFailed(updated.orderId, input.reason).catch((err) => console.error("falha ao notificar problema na entrega pro cliente:", err));

  return serialize(updated);
}

// ---------- GET /manager/deliveries ----------
export async function listManagerDeliveriesUsecase(input: { statuses?: DeliveryStatus[] }) {
  const rows = await db.query.deliveries.findMany({
    where: input.statuses?.length ? inArray(deliveries.status, input.statuses) : undefined,
    orderBy: (d, { asc }) => asc(d.createdAt),
  });

  const courierIds = [...new Set(rows.map((d) => d.courierId).filter((id): id is string => !!id))];
  const couriers = courierIds.length
    ? await db.query.users.findMany({ where: inArray(users.id, courierIds as string[]) })
    : [];
  const courierById = new Map(couriers.map((c) => [c.id, c]));

  return rows.map((d) => ({
    ...serialize(d),
    courier: d.courierId ? { id: d.courierId, name: (courierById.get(d.courierId) as any)?.name ?? null } : null,
  }));
}

// ---------- PATCH /manager/deliveries/:id/assign ----------
export async function assignCourierUsecase(input: { deliveryId: string; courierId: string; managerId: string }) {
  const courier = await db.query.users.findFirst({ where: eq(users.id, input.courierId) });
  if (!courier || courier.role !== "courier") throw Errors.invalidCourierRole();

  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.id, input.deliveryId) });
  if (!delivery) throw Errors.notFound("Entrega");

  const updated = db.transaction((tx) => {
    const result = tx
      .update(deliveries)
      .set({ courierId: input.courierId })
      .where(eq(deliveries.id, input.deliveryId))
      .returning()
      .get();
    // Atribuir não muda o status — continua awaiting_courier até o entregador
    // confirmar saída via dispatch (§05 "Endpoints do manager").
    enqueueEvent(tx, DELIVERY_ROOM, "delivery.assigned", serialize(result));
    logAction(tx, input.managerId, "delivery_assigned", result.orderId, { courierId: input.courierId });
    return result;
  });

  return serialize(updated);
}

// ---------- GET /manager/couriers ----------
export async function listCouriersUsecase() {
  const rows = await db.query.users.findMany({ where: eq(users.role, "courier") });
  return rows.map((u) => ({ id: u.id, name: u.name, active: u.active }));
}

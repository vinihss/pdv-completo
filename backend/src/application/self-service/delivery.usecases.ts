import { eq, inArray, and } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { deliveries, users, orders, customers, customerAddresses, courierLocations } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { canTransitionDelivery, type DeliveryStatus } from "../../domain/customer-order-state.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";
import { createAlertTx, DELIVERY_ASSIGNED_ALERT_KIND, describeDeliveryAssignedAlert } from "../alert/alert.usecases.js";
import { emitCustomerStageChangedTx } from "./customer-stage.js";
import { closeOrderAfterDelivery } from "./manager-delivery-status.usecase.js";
import {
  notifyDispatched,
  notifyDelivered,
  notifyFailed,
  notifyArriving,
} from "../../integrations/whatsapp/whatsapp.notifier.js";
import { printCourierOrder } from "../../integrations/printer/printer.usecases.js";
import { getSettings } from "../order/order.usecases.js";
import { photoUrl } from "../user.usecases.js";
import { OsmRoutingService } from "../../integrations/maps/routing.service.js";

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
    // Previsão gravada no insert do checkout (order-intake.usecase.ts §4.1).
    // As duas colunas existiam e nenhuma lista as expunha — sem elas o gerente
    // não tem como estimar a chegada do entregador no card da entrega.
    distanceKm: d.distanceKm,
    estimatedMinutes: d.estimatedMinutes,
  };
}

// Coordenadas do destino para o mapa (marker de destino). A delivery não tem
// FK para customer_address — guarda só o snapshot em texto — então a ligação é
// por projeção na leitura: delivery → order.customer_id → endereço padrão do
// cliente (is_default; sem padrão, o primeiro cadastrado). Sem endereço ou sem
// georreferência, os campos saem null e o mapa simplesmente não desenha o
// marker.
//
// Única fonte da projeção, compartilhada por GET /courier/deliveries e
// GET /manager/deliveries: são as mesmas duas leituras em lote, e duas cópias
// divergiriam no primeiro conserto da regra de "endereço padrão".
async function addressCoordsByOrderId(
  orderRows: { id: string; customerId: string | null }[]
): Promise<Map<string, { latitude: number | null; longitude: number | null }>> {
  const customerIds = [
    ...new Set(orderRows.map((o) => o.customerId).filter((id): id is string => !!id)),
  ];
  const addressRows = customerIds.length
    ? await db.query.customerAddresses.findMany({ where: inArray(customerAddresses.customerId, customerIds) })
    : [];
  const addressByCustomerId = new Map<string, typeof customerAddresses.$inferSelect>();
  for (const a of addressRows) {
    const current = addressByCustomerId.get(a.customerId);
    if (!current || (!current.isDefault && a.isDefault)) addressByCustomerId.set(a.customerId, a);
  }

  const coords = new Map<string, { latitude: number | null; longitude: number | null }>();
  for (const o of orderRows) {
    const address = o.customerId ? addressByCustomerId.get(o.customerId) : undefined;
    coords.set(o.id, { latitude: address?.latitude ?? null, longitude: address?.longitude ?? null });
  }
  return coords;
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

  // Coordenadas do destino para o mapa do entregador (marker de destino no
  // CourierTrackingMap) — projeção compartilhada, ver addressCoordsByOrderId.
  const orderIds = [...new Set(rows.map((d) => d.orderId))];
  const orderRows = orderIds.length
    ? await db.query.orders.findMany({ where: inArray(orders.id, orderIds) })
    : [];
  const coordsByOrderId = await addressCoordsByOrderId(orderRows);

  return rows.map((d) => ({
    ...serialize(d),
    addressLatitude: coordsByOrderId.get(d.orderId)?.latitude ?? null,
    addressLongitude: coordsByOrderId.get(d.orderId)?.longitude ?? null,
  }));
}

// ---------- PATCH /courier/deliveries/:id/dispatch ----------
export async function dispatchDeliveryUsecase(input: {
  deliveryId: string;
  courierId: string;
}) {
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
export async function deliverDeliveryUsecase(input: {
  deliveryId: string;
  courierId: string;
}) {
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

  // Mesma projeção do GET /courier/deliveries (helper compartilhado): o mapa do
  // gerente desenha o marker de destino no card de cada entrega.
  const coordsByOrderId = await addressCoordsByOrderId(orderRows);

  return rows.map((d) => ({
    ...serialize(d),
    courier: d.courierId ? { id: d.courierId, name: (courierById.get(d.courierId) as any)?.name ?? null } : null,
    customerName: customerNameFor(orderById.get(d.orderId), customerNameById),
    addressLatitude: coordsByOrderId.get(d.orderId)?.latitude ?? null,
    addressLongitude: coordsByOrderId.get(d.orderId)?.longitude ?? null,
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

// ---------- POST /courier/location ----------
// Ping de localização do app do entregador. Só vale enquanto ele tem entrega
// em rota: fora disso o rastreamento vira vigilância sem propósito de
// negócio (e o gerente não precisa saber onde o entregador está no dia de
// folga). Upsert — uma linha por courier, a última posição é a única que
// interessa. SEM audit_log: ping de alta frequência poluiria o log; o rastro
// é o evento realtime no outbox, gravado na mesma transação do upsert.
export async function reportCourierLocationUsecase(input: {
  courierId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}) {
  const onRoute = await db.query.deliveries.findFirst({
    where: (d, { and, eq: eqOp }) => and(eqOp(d.courierId, input.courierId), eqOp(d.status, "out_for_delivery")),
    columns: { id: true },
  });
  if (!onRoute) throw Errors.courierNotOnRoute();

  const now = new Date().toISOString();
  const [row] = await db.transaction(async (tx) => {
    // Nome e foto do entregador lidos NA MESMA transação do upsert: o evento
    // realtime é o par da carga inicial de GET /manager/deliveries/locations e
    // precisa vir com os mesmos campos (courierName/photoPath), senão o marcador
    // que já está no mapa perde o rosto quando o ping chega. O `photoPath` sai
    // como URL pública (`/uploads/user/<arquivo>`), igual a todo o resto da API.
    const courier = await tx.query.users.findFirst({
      where: eq(users.id, input.courierId),
      columns: { name: true, photoPath: true },
    });
    const [upserted] = await tx
      .insert(courierLocations)
      .values({
        courierId: input.courierId,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: courierLocations.courierId,
        set: { latitude: input.latitude, longitude: input.longitude, accuracy: input.accuracy ?? null, updatedAt: now },
      })
      .returning();
    // Accuracy vai junto: ela não é dado sensível (é a incerteza do GPS, não
    // a posição) e o mapa do gerente precisa dela para não fingir precisão
    // que o device não tem. Os campos novos SOMAM ao contrato — nenhum dos
    // existentes sai.
    await enqueueEvent(tx, DELIVERY_ROOM, "courier.location", {
      courierId: input.courierId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy ?? null,
      updatedAt: now,
      courierName: courier?.name ?? null,
      photoPath: photoUrl(courier?.photoPath, "user"),
    });
    // Verifica se o entregador está a <= 5 min do destino (regra de
    // negócio para o WhatsApp "Sua entrega está chegando!"): calcula a rota
    // OSRM entre a posição atual do courier e o endereço de entrega e, se o
    // tempo for <= 5 min e o alerta ainda não foi enviado, envia a mensagem e
    // marca a flag na própria delivery. Tudo isso é fire-and-forget: falha de
    // rota, OSRM fora do ar ou erro no envio não derrubam o ping.
    const deliveryRow = await tx.query.deliveries.findFirst({
      where: (d, { and, eq: eqOp }) =>
        and(eqOp(d.courierId, input.courierId), eqOp(d.status, "out_for_delivery")),
    });
    if (
      deliveryRow &&
      deliveryRow.status === "out_for_delivery" &&
      !deliveryRow.arrivalAlertSent &&
      upserted?.latitude != null &&
      upserted?.longitude != null
    ) {
      try {
        const orderRow = await tx.query.orders.findFirst({
          where: eq(orders.id, deliveryRow.orderId),
          columns: { customerId: true },
        });
        if (orderRow?.customerId) {
          const customerRow = await tx.query.customers.findFirst({
            where: eq(customers.id, orderRow.customerId),
            columns: { id: true },
          });
          if (customerRow) {
            const coords = await addressCoordsByOrderId([{ id: deliveryRow.orderId, customerId: customerRow.id }]);
            const coord = coords.get(deliveryRow.orderId);
            if (coord?.latitude != null && coord?.longitude != null) {
              const route = await calculateRoute(
                upserted.longitude, upserted.latitude,
                coord.longitude, coord.latitude
              );
              if (route != null && route.durationMinutes <= 5) {
                await tx
                  .update(deliveries)
                  .set({ arrivalAlertSent: true })
                  .where(eq(deliveries.id, deliveryRow.id));
                notifyArriving(deliveryRow.orderId).catch((err) =>
                  console.error("[whatsapp] erro ao enviar alerta de chegada:", err)
                );
              }
            }
          }
        }
      } catch (err) {
        console.error("[entregas] erro ao checar alerta de chegada:", err);
      }
    }
    return [upserted];
  });

  return row;
}

// ---------- GET /manager/deliveries/locations ----------
// Última posição dos entregadores com entrega em rota AGORA. O join parte da
// delivery (fonte da verdade do "em rota"), não da courier_location: um
// entregador que terminou a rota continua com a linha dele na tabela (é a
// última posição conhecida), mas não deve aparecer no mapa.
export async function listCourierLocationsUsecase() {
  const rows = await db
    .select({
      courierId: courierLocations.courierId,
      courierName: users.name,
      // Basename no banco, URL pública na resposta — mesma regra de todo o
      // resto da API (photoUrl em application/user.usecases.ts).
      photoPath: users.photoPath,
      latitude: courierLocations.latitude,
      longitude: courierLocations.longitude,
      updatedAt: courierLocations.updatedAt,
    })
    .from(deliveries)
    .innerJoin(courierLocations, eq(courierLocations.courierId, deliveries.courierId))
    .innerJoin(users, eq(users.id, deliveries.courierId))
    .where(eq(deliveries.status, "out_for_delivery"));
  // Um courier pode ter 2+ entregas em rota — dedupe por courierId, a
  // localização é a mesma linha.
  const byCourier = new Map(rows.map((r) => [r.courierId, r]));
  return [...byCourier.values()].map((r) => ({ ...r, photoPath: photoUrl(r.photoPath, "user") }));
}

// ---------- GET /manager/couriers ----------
export async function listCouriersUsecase() {
  const rows = await db.query.users.findMany({ where: eq(users.role, "courier") });
  return rows.map((u) => ({ id: u.id, name: u.name, active: u.active }));
}

/**
 * Calcula a rota entre duas coordenadas usando o serviço OSRM configurado.
 *
 * Retorna o objeto { distanceKm, durationMinutes } ou null em caso de erro.
 * Wrapper leve em torno de `OsmRoutingService` para não depender de `setMapServices`
 * nem do DI do `calcularEntregaUsecase` — o mesmo serviço que o checkout usa.
 */
async function calculateRoute(
  courierLongitude: number,
  courierLatitude: number,
  destinationLongitude: number,
  destinationLatitude: number
): Promise<{ distanceKm: number; durationMinutes: number } | null> {
  try {
    const service = new OsmRoutingService();
    const result = await service.calculateRoute(
      { latitude: courierLatitude, longitude: courierLongitude },
      { latitude: destinationLatitude, longitude: destinationLongitude }
    );
    return {
      distanceKm: result.distanceKm,
      durationMinutes: result.durationMinutes,
    };
  } catch (err) {
    console.error("[entregas] rota OSRM falhou:", err);
    return null;
  }
}

// Entrega (courier + manager) — ONDA 3 da refatoração arquitetural.
//
// Este arquivo é uma FACTORY pura (`createSelfServiceDeliveryUsecases(deps)`):
// nenhuma importação de infra/integrations/config nem Drizzle. Toda
// persistência/efeito transacional passa pelo `uow.run`/`session.*`
// (deliveries, orders, users, customers, customerAddresses, courierLocations,
// audit, outbox); os efeitos pós-commit (settings + impressão do cupom do
// entregador) chegam via deps/ports. O fechamento da comanda compartilhado com
// o gerente chega INJETADO (`closeOrderAfterDelivery`), criado uma única vez
// pela composition root — mesma composição do `cancelSelfServiceOrderUsecase`.
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): as leituras que antes rodavam "fora
// do tx" (entrega, itens, settings) entram no MESMO `uow.run` da escrita. Sob
// READ COMMITTED o resultado é o mesmo (snapshot por statement); o ganho é um
// caminho só para ler e escrever, sem meio-commit. A impressão continua
// PÓS-COMMIT (fire-and-forget, como sempre).
import { Errors } from "../../domain/errors.js";
import { canTransitionDelivery, type DeliveryStatus } from "../../domain/customer-order-state.js";
import {
  createAlert,
  DELIVERY_ASSIGNED_ALERT_KIND,
  describeDeliveryAssignedAlert,
} from "../alert/alert.usecases.js";
import { emitCustomerStageChanged } from "./customer-stage.js";
import type { CloseOrderAfterDelivery } from "./manager-delivery-status.usecase.js";
import type { TenantSession, TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { CustomerAddressRecord, DeliveryRecord, OrderRow } from "../ports/repositories.js";
import type { OrderPrinter, StoreSettingsReader } from "../ports/effects.js";

const DELIVERY_ROOM = "deliveries";

// `/uploads/user/<filename>` — mesmo formato de `storageAssetPath("user", ...)`
// de `infra/storage`. Definido aqui (em vez de importar infra) porque a
// application não depende da camada de armazenamento: a URL é derivação pura
// do basename já persistido (mesmo padrão de `product.usecases`/`menu`).
const UPLOADS_PREFIX = "/uploads";
function userPhotoUrl(photoPath: string | null | undefined): string | null {
  return photoPath ? `${UPLOADS_PREFIX}/user/${photoPath}` : null;
}

function serialize(d: DeliveryRecord) {
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
  session: TenantSession,
  orderRows: { id: string; customerId: string | null }[],
): Promise<Map<string, { latitude: number | null; longitude: number | null }>> {
  const customerIds = [
    ...new Set(orderRows.map((o) => o.customerId).filter((id): id is string => !!id)),
  ];
  const addressRows: CustomerAddressRecord[] = customerIds.length
    ? await session.customerAddresses.listByCustomers(customerIds)
    : [];
  const addressByCustomerId = new Map<string, CustomerAddressRecord>();
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

async function getOwnedDelivery(session: TenantSession, deliveryId: string, courierId: string): Promise<DeliveryRecord> {
  const delivery = await session.deliveries.findById(deliveryId);
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
  order: Pick<OrderRow, "customerId" | "tabLabel"> | undefined,
  nameByCustomerId: Map<string, string>,
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

// ---------- factory ----------

export interface SelfServiceDeliveryUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  settings: StoreSettingsReader;
  printer: OrderPrinter;
  /** Efeito compartilhado com o gerente — criado uma vez na composition root. */
  closeOrderAfterDelivery: CloseOrderAfterDelivery;
}

/**
 * As use cases de entrega (courier + manager) sobre o Unit-of-Worker, com as
 * MESMAS assinaturas de input das funções antigas. Os nomes legados são
 * re-exportados por `infra/composition/default-usecases.ts`.
 */
export function createSelfServiceDeliveryUsecases(deps: SelfServiceDeliveryUsecasesDeps) {
  return {
    // ---------- GET /courier/deliveries ----------
    async listCourierDeliveriesUsecase(input: { courierId: string; statuses?: DeliveryStatus[] }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.deliveries.listForCourier(input.courierId, input.statuses);

        // Coordenadas do destino para o mapa do entregador (marker de destino no
        // CourierTrackingMap) — projeção compartilhada, ver addressCoordsByOrderId.
        const orderIds = [...new Set(rows.map((d) => d.orderId))];
        const orderRows = orderIds.length ? await session.orders.listRowsByIds(orderIds) : [];
        const coordsByOrderId = await addressCoordsByOrderId(session, orderRows);

        return rows.map((d) => ({
          ...serialize(d),
          addressLatitude: coordsByOrderId.get(d.orderId)?.latitude ?? null,
          addressLongitude: coordsByOrderId.get(d.orderId)?.longitude ?? null,
        }));
      });
    },

    // ---------- PATCH /courier/deliveries/:id/dispatch ----------
    async dispatchDeliveryUsecase(input: { deliveryId: string; courierId: string }) {
      const updated = await deps.uow.run(deps.tenant(), async (session) => {
        const delivery = await getOwnedDelivery(session, input.deliveryId, input.courierId);
        // Transição validada pela máquina declarativa (customer-order-state.ts) —
        // regra única compartilhada com deliver/fail/cancelamento.
        if (!canTransitionDelivery(delivery.status, "out_for_delivery"))
          throw Errors.invalidDeliveryTransition("Entrega não está aguardando entregador.");

        const result = await session.deliveries.transition(input.deliveryId, "out_for_delivery");
        await session.outbox.enqueue({
          room: DELIVERY_ROOM,
          type: "delivery.status_changed",
          aggregateId: result.id,
          payload: serialize(result),
        });
        await emitCustomerStageChanged(session, result.orderId);
        await session.audit.record({
          actorId: input.courierId,
          action: "delivery_dispatched",
          orderId: result.orderId,
          details: {},
        });
        return result;
      });

      // Impressão automática do courier (pós-commit, fire-and-forget).
      try {
        const settings = await deps.settings.get();
        if (settings.printerEnabled && settings.printerAutoPrint) {
          deps.printer
            .printCourierOrder(updated.orderId)
            .catch((err) => console.error("falha ao imprimir comanda no courier:", err));
        }
      } catch (err) {
        console.error("falha ao verificar flags de impressão:", err);
      }

      return serialize(updated);
    },

    // ---------- PATCH /courier/deliveries/:id/deliver ----------
    async deliverDeliveryUsecase(input: { deliveryId: string; courierId: string }) {
      const updated = await deps.uow.run(deps.tenant(), async (session) => {
        const delivery = await getOwnedDelivery(session, input.deliveryId, input.courierId);
        if (!canTransitionDelivery(delivery.status, "delivered"))
          throw Errors.invalidDeliveryTransition("Entrega não está em trânsito.");

        const result = await session.deliveries.transition(input.deliveryId, "delivered");
        await session.outbox.enqueue({
          room: DELIVERY_ROOM,
          type: "delivery.status_changed",
          aggregateId: result.id,
          payload: serialize(result),
        });
        await emitCustomerStageChanged(session, result.orderId);
        await session.outbox.enqueue({
          room: `order:${result.orderId}`,
          type: "delivery.delivered",
          aggregateId: result.orderId,
          payload: { orderId: result.orderId },
        });
        await session.audit.record({
          actorId: input.courierId,
          action: "delivery_completed",
          orderId: result.orderId,
          details: {},
        });
        return result;
      });

      // Fecha o pedido de verdade — sem isso ele fica preso em "open" pra sempre,
      // porque order_item nunca chega a "delivered" numa entrega (não há garçom
      // servindo mesa) e closeOrderUsecase exige isso + paymentMethod registrado.
      //
      // Compartilhado com `setDeliveryStatusUsecase` (gerente marcando entregue
      // pelo balcão): os dois precisam do mesmo efeito, e duas cópias divergem
      // no primeiro conserto de uma delas. O comentário da factory explica.
      await deps.closeOrderAfterDelivery(updated.orderId, input.courierId);

      return serialize(updated);
    },

    // ---------- PATCH /courier/deliveries/:id/fail ----------
    async failDeliveryUsecase(input: { deliveryId: string; courierId: string; reason: string }) {
      const updated = await deps.uow.run(deps.tenant(), async (session) => {
        const delivery = await getOwnedDelivery(session, input.deliveryId, input.courierId);
        if (!canTransitionDelivery(delivery.status, "failed"))
          throw Errors.invalidDeliveryTransition("Entrega não está em trânsito.");

        const result = await session.deliveries.fail(input.deliveryId, input.reason);
        await session.outbox.enqueue({
          room: DELIVERY_ROOM,
          type: "delivery.status_changed",
          aggregateId: result.id,
          payload: serialize(result),
        });
        await emitCustomerStageChanged(session, result.orderId);
        await session.audit.record({
          actorId: input.courierId,
          action: "delivery_failed",
          orderId: result.orderId,
          details: { reason: input.reason },
        });
        return result;
      });

      return serialize(updated);
    },

    // ---------- GET /manager/deliveries ----------
    async listManagerDeliveriesUsecase(input: { statuses?: DeliveryStatus[] }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // Do mais novo pro mais antigo: quem gerencia entrega precisa ver primeiro
        // o que acabou de cair. (A lista do entregador continua em ASC de propósito
        // — a fila dele é a mais antiga primeiro.)
        const rows = await session.deliveries.listAll(input.statuses);

        const courierIds = [...new Set(rows.map((d) => d.courierId).filter((id): id is string => !!id))];
        const couriers = courierIds.length ? await session.users.findByIds(courierIds) : [];
        const courierById = new Map(couriers.map((c) => [c.id, c]));

        // Nome do cliente, sem uma query por card: duas leituras em lote (comandas
        // das entregas, depois os clientes dessas comandas) resolvem a lista toda.
        const orderIds = [...new Set(rows.map((d) => d.orderId))];
        const orderRows = orderIds.length ? await session.orders.listRowsByIds(orderIds) : [];
        const customerIds = [
          ...new Set(orderRows.map((o) => o.customerId).filter((id): id is string => !!id)),
        ];
        const customerRows = customerIds.length ? await session.customers.findByIds(customerIds) : [];
        const customerNameById = new Map(customerRows.map((c) => [c.id, c.name]));
        const orderById = new Map(orderRows.map((o) => [o.id, o]));

        // Mesma projeção do GET /courier/deliveries (helper compartilhado): o mapa
        // do gerente desenha o marker de destino no card de cada entrega.
        const coordsByOrderId = await addressCoordsByOrderId(session, orderRows);

        return rows.map((d) => ({
          ...serialize(d),
          courier: d.courierId ? { id: d.courierId, name: courierById.get(d.courierId)?.name ?? null } : null,
          customerName: customerNameFor(orderById.get(d.orderId), customerNameById),
          addressLatitude: coordsByOrderId.get(d.orderId)?.latitude ?? null,
          addressLongitude: coordsByOrderId.get(d.orderId)?.longitude ?? null,
        }));
      });
    },

    // ---------- PATCH /manager/deliveries/:id/assign ----------
    async assignCourierUsecase(input: { deliveryId: string; courierId: string; managerId: string }) {
      const updated = await deps.uow.run(deps.tenant(), async (session) => {
        const courier = await session.users.findById(input.courierId);
        if (!courier || courier.role !== "courier") throw Errors.invalidCourierRole();

        const delivery = await session.deliveries.findById(input.deliveryId);
        if (!delivery) throw Errors.notFound("Entrega");

        const result = await session.deliveries.assignCourier(input.deliveryId, input.courierId);
        // Atribuir não muda o status — continua awaiting_courier até o entregador
        // confirmar saída via dispatch (§05 "Endpoints do manager").
        await session.outbox.enqueue({
          room: DELIVERY_ROOM,
          type: "delivery.assigned",
          aggregateId: result.id,
          payload: serialize(result),
        });
        // O `delivery.assigned` vai para o room `deliveries`, que é de TODOS os
        // entregadores: ele serve para a tela recarregar, não para avisar. O aviso
        // é o alerta, e ele é DIRECIONADO — só o entregador que acabou de receber
        // a entrega ouve (audiência `user:<id>`, room `alerts:user:<id>`).
        const { title, body } = describeDeliveryAssignedAlert({
          orderId: result.orderId,
          address: result.address,
        });
        await createAlert(session, {
          kind: DELIVERY_ASSIGNED_ALERT_KIND,
          title,
          body,
          orderId: result.orderId,
          // O destinatário é o `courierId` validado lá em cima (papel `courier`),
          // e não o que voltou no UPDATE — que o schema tipa como nulo por causa
          // do `ON DELETE SET NULL` da coluna. São o mesmo id.
          userIds: [input.courierId],
        });
        await session.audit.record({
          actorId: input.managerId,
          action: "delivery_assigned",
          orderId: result.orderId,
          details: { courierId: input.courierId },
        });
        return result;
      });

      return serialize(updated);
    },

    // ---------- POST /courier/location ----------
    // Ping de localização do app do entregador. Só vale enquanto ele tem entrega
    // em rota: fora disso o rastreamento vira vigilância sem propósito de
    // negócio (e o gerente não precisa saber onde o entregador está no dia de
    // folga). Upsert — uma linha por courier, a última posição é a única que
    // interessa. SEM audit_log: ping de alta frequência poluiria o log; o rastro
    // é o evento realtime no outbox, gravado na mesma transação do upsert.
    async reportCourierLocationUsecase(input: {
      courierId: string;
      latitude: number;
      longitude: number;
      accuracy?: number | null;
    }) {
      const now = new Date().toISOString();
      return deps.uow.run(deps.tenant(), async (session) => {
        const onRoute = await session.deliveries.findActiveForCourier(input.courierId);
        if (!onRoute) throw Errors.courierNotOnRoute();

        // Nome e foto do entregador lidos NA MESMA transação do upsert: o evento
        // realtime é o par da carga inicial de GET /manager/deliveries/locations e
        // precisa vir com os mesmos campos (courierName/photoPath), senão o marcador
        // que já está no mapa perde o rosto quando o ping chega. O `photoPath` sai
        // como URL pública (`/uploads/user/<arquivo>`), igual a todo o resto da API.
        const courier = await session.users.findById(input.courierId);
        const row = await session.courierLocations.upsert({
          courierId: input.courierId,
          latitude: input.latitude,
          longitude: input.longitude,
          accuracy: input.accuracy ?? null,
          updatedAt: now,
        });
        // Accuracy vai junto: ela não é dado sensível (é a incerteza do GPS, não
        // a posição) e o mapa do gerente precisa dela para não fingir precisão
        // que o device não tem. Os campos novos SOMAM ao contrato — nenhum dos
        // existentes sai.
        await session.outbox.enqueue({
          room: DELIVERY_ROOM,
          type: "courier.location",
          aggregateId: input.courierId,
          payload: {
            courierId: input.courierId,
            latitude: input.latitude,
            longitude: input.longitude,
            accuracy: input.accuracy ?? null,
            updatedAt: now,
            courierName: courier?.name ?? null,
            photoPath: userPhotoUrl(courier?.photoPath ?? null),
          },
        });
        return row;
      });
    },

    // ---------- GET /manager/deliveries/locations ----------
    // Última posição dos entregadores com entrega em rota AGORA. O join parte da
    // delivery (fonte da verdade do "em rota"), não da courier_location: um
    // entregador que terminou a rota continua com a linha dele na tabela (é a
    // última posição conhecida), mas não deve aparecer no mapa.
    async listCourierLocationsUsecase() {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.courierLocations.listOnRoute();
        // Um courier pode ter 2+ entregas em rota — dedupe por courierId, a
        // localização é a mesma linha.
        const byCourier = new Map(rows.map((r) => [r.courierId, r]));
        // Basename no banco, URL pública na resposta — mesma regra de todo o
        // resto da API (photoUrl em application/user/shared/user-helpers.ts).
        return [...byCourier.values()].map((r) => ({ ...r, photoPath: userPhotoUrl(r.photoPath) }));
      });
    },

    // ---------- GET /manager/couriers ----------
    async listCouriersUsecase() {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.users.listByRole("courier");
        return rows.map((u) => ({ id: u.id, name: u.name, active: u.active }));
      });
    },
  };
}

export type SelfServiceDeliveryUsecases = ReturnType<typeof createSelfServiceDeliveryUsecases>;

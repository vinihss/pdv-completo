import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { deliveries } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import type {
  DeliveryRecord,
  DeliveryRepository,
  DeliveryStatus,
  Id,
  Page,
  PageQuery,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Entregas
// =====================================================================

function toDeliveryRecord(d: typeof deliveries.$inferSelect): DeliveryRecord {
  return {
    id: d.id,
    orderId: d.orderId,
    courierId: d.courierId,
    address: d.address,
    distanceKm: d.distanceKm,
    estimatedMinutes: d.estimatedMinutes,
    status: d.status,
    dispatchedAt: d.dispatchedAt,
    deliveredAt: d.deliveredAt,
    notes: d.notes,
    createdAt: d.createdAt,
  };
}

export class PostgresDeliveryRepository implements DeliveryRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<DeliveryRecord | null> {
    const row = await this.tx.query.deliveries.findFirst({ where: eq(deliveries.id, id) });
    return row ? toDeliveryRecord(row) : null;
  }

  /** 1:1 com a comanda (`delivery.order_id` UNIQUE). */
  async findByOrder(orderId: Id): Promise<DeliveryRecord | null> {
    const row = await this.tx.query.deliveries.findFirst({ where: eq(deliveries.orderId, orderId) });
    return row ? toDeliveryRecord(row) : null;
  }

  /**
   * Mais recentes primeiro (visão do manager). Observação: as duas superfícies
   * atuais divergem — manager ordena `createdAt DESC`, courier `ASC`; quando a
   * rota migrar, alinhar a ordenação desejada aqui.
   */
  async list(query: PageQuery & { status?: DeliveryStatus; courierId?: Id }): Promise<Page<DeliveryRecord>> {
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(deliveries.status, query.status));
    if (query.courierId) conditions.push(eq(deliveries.courierId, query.courierId));
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.tx.query.deliveries.findMany({
      where,
      orderBy: desc(deliveries.createdAt),
      limit: query.limit,
      offset: query.offset,
    });
    const totalRow = await this.tx.select({ count: count() }).from(deliveries).where(where);
    return { data: rows.map(toDeliveryRecord), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  /**
   * Só atribui (o status continua `awaiting_courier` até o dispatch, como
   * `assignCourierUsecase`). A validação de papel (`courier`), o alerta
   * direcionado e o audit ficam no use case migrado.
   */
  async assignCourier(id: Id, courierId: Id): Promise<DeliveryRecord> {
    const [row] = await this.tx
      .update(deliveries)
      .set({ courierId })
      .where(eq(deliveries.id, id))
      .returning();
    if (!row) throw Errors.notFound("Entrega");
    return toDeliveryRecord(row);
  }

  /**
   * Troca o status e carimba os timestamps que a máquina de estados usa
   * (`dispatchedAt` na saída para entrega, `deliveredAt` na entrega). A
   * validação de transição (`canTransitionDelivery`) continua no use case.
   */
  async transition(id: Id, status: DeliveryStatus): Promise<DeliveryRecord> {
    const now = new Date().toISOString();
    const [row] = await this.tx
      .update(deliveries)
      .set({
        status,
        ...(status === "out_for_delivery" ? { dispatchedAt: now } : {}),
        ...(status === "delivered" ? { deliveredAt: now } : {}),
      })
      .where(eq(deliveries.id, id))
      .returning();
    if (!row) throw Errors.notFound("Entrega");
    return toDeliveryRecord(row);
  }

  /** ADIÇÃO (Onda 2): lote por comandas — hidratação da listagem sem N+1. */
  async listByOrderIds(ids: Id[]): Promise<DeliveryRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.query.deliveries.findMany({ where: inArray(deliveries.orderId, ids) });
    return rows.map(toDeliveryRecord);
  }

  // ---------- ADIÇÕES (Onda 3 — self-service) ----------

  /** INSERT da entrega do checkout (status inicial `awaiting_courier`). */
  async create(input: {
    orderId: Id;
    address: string;
    status: DeliveryStatus;
    distanceKm: number | null;
    estimatedMinutes: number;
  }): Promise<DeliveryRecord> {
    const [row] = await this.tx
      .insert(deliveries)
      .values({
        orderId: input.orderId,
        address: input.address,
        status: input.status,
        distanceKm: input.distanceKm,
        estimatedMinutes: input.estimatedMinutes,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "orderId" });
    return toDeliveryRecord(row);
  }

  /** Todas as entregas (opcionalmente por status), mais recentes primeiro. */
  async listAll(statuses?: DeliveryStatus[]): Promise<DeliveryRecord[]> {
    const rows = await this.tx.query.deliveries.findMany({
      where: statuses?.length ? inArray(deliveries.status, statuses) : undefined,
      orderBy: desc(deliveries.createdAt),
    });
    return rows.map(toDeliveryRecord);
  }

  /** Fila do entregador (opcionalmente por status), mais antigas primeiro. */
  async listForCourier(courierId: Id, statuses?: DeliveryStatus[]): Promise<DeliveryRecord[]> {
    const rows = await this.tx.query.deliveries.findMany({
      where: and(
        eq(deliveries.courierId, courierId),
        statuses?.length ? inArray(deliveries.status, statuses) : undefined,
      ),
      orderBy: asc(deliveries.createdAt),
    });
    return rows.map(toDeliveryRecord);
  }

  /** Falha da entrega: status + motivo no mesmo UPDATE. */
  async fail(id: Id, reason: string): Promise<DeliveryRecord> {
    const [row] = await this.tx
      .update(deliveries)
      .set({ status: "failed", notes: reason })
      .where(eq(deliveries.id, id))
      .returning();
    if (!row) throw Errors.notFound("Entrega");
    return toDeliveryRecord(row);
  }

  /** Edição de status do gerente: preserva `dispatchedAt` (não passa por `transition`). */
  async setStatus(
    id: Id,
    patch: { status: DeliveryStatus; deliveredAt: string | null; notes: string | null },
  ): Promise<DeliveryRecord> {
    const [row] = await this.tx
      .update(deliveries)
      .set({ status: patch.status, deliveredAt: patch.deliveredAt, notes: patch.notes })
      .where(eq(deliveries.id, id))
      .returning();
    if (!row) throw Errors.notFound("Entrega");
    return toDeliveryRecord(row);
  }

  /** Entrega em rota AGORA do entregador (guard do POST /courier/location). */
  async findActiveForCourier(courierId: Id): Promise<DeliveryRecord | null> {
    const row = await this.tx.query.deliveries.findFirst({
      where: and(eq(deliveries.courierId, courierId), eq(deliveries.status, "out_for_delivery")),
    });
    return row ? toDeliveryRecord(row) : null;
  }
}


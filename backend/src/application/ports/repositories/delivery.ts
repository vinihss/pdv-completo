/**
 * Port de entregas (`delivery`) — fila do entregador e painel do gerente.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/delivery.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { DeliveryStatus, Id, Page, PageQuery } from "./shared.js";

export interface DeliveryRecord {
  id: Id;
  orderId: Id;
  courierId: Id | null;
  address: string;
  distanceKm: number | null;
  estimatedMinutes: number | null;
  status: DeliveryStatus;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface DeliveryRepository {
  findById(id: Id): Promise<DeliveryRecord | null>;
  findByOrder(orderId: Id): Promise<DeliveryRecord | null>;
  list(query: PageQuery & { status?: DeliveryStatus; courierId?: Id }): Promise<Page<DeliveryRecord>>;
  /** Atribui o entregador (não muda o status — segue awaiting_courier até o dispatch). */
  assignCourier(id: Id, courierId: Id): Promise<DeliveryRecord>;
  transition(id: Id, status: DeliveryStatus): Promise<DeliveryRecord>;
  /** ADIÇÃO (Onda 2): lote por comandas (hidratação da listagem de comandas — uma query só). */
  listByOrderIds(ids: Id[]): Promise<DeliveryRecord[]>;

  // ---------- ADIÇÕES (Onda 3 — self-service) ----------
  /** INSERT da entrega do checkout self-service (status inicial `awaiting_courier`). */
  create(input: {
    orderId: Id;
    address: string;
    status: DeliveryStatus;
    distanceKm: number | null;
    estimatedMinutes: number;
  }): Promise<DeliveryRecord>;
  /**
   * Todas as entregas (sem paginação), opcionalmente filtradas por status,
   * mais recentes primeiro — `GET /manager/deliveries`.
   */
  listAll(statuses?: DeliveryStatus[]): Promise<DeliveryRecord[]>;
  /**
   * Fila do entregador (opcionalmente filtrada por status), mais antigas
   * primeiro — `GET /courier/deliveries`.
   */
  listForCourier(courierId: Id, statuses?: DeliveryStatus[]): Promise<DeliveryRecord[]>;
  /** Falha da entrega (`status = failed` + `notes = reason`) — `PATCH .../fail`. */
  fail(id: Id, reason: string): Promise<DeliveryRecord>;
  /**
   * Edição de status do gerente: grava `status` + `deliveredAt`/`notes` já
   * resolvidos pelo use case, PRESERVANDO `dispatchedAt` (o gerente não
   * carimba a saída; quem faz isso é o `dispatch` do entregador).
   */
  setStatus(
    id: Id,
    patch: { status: DeliveryStatus; deliveredAt: string | null; notes: string | null },
  ): Promise<DeliveryRecord>;
  /** Entrega em rota AGORA do entregador (guard do `POST /courier/location`). */
  findActiveForCourier(courierId: Id): Promise<DeliveryRecord | null>;
}

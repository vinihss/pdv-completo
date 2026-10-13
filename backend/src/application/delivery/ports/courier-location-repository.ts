/**
 * Port de posições de entregadores (`courier_location`, migration 0003).
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/courier-location.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id } from "../../ports/repositories/shared.js";

/**
 * ADIÇÃO (Onda 3 — self-service): última posição do entregador
 * (`courier_location`, migration 0003). Uma linha por courier; `upsert` é
 * last-write-wins e `listOnRoute` parte da `delivery` em rota (fonte da
 * verdade do "em rota"), não da tabela de posições.
 */
export interface CourierLocationRecord {
  courierId: Id;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  updatedAt: string;
}

export interface CourierLocationRepository {
  /** Upsert por courier (a última posição é a única que interessa) e devolve a linha gravada. */
  upsert(input: {
    courierId: Id;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    updatedAt: string;
  }): Promise<CourierLocationRecord>;
  /**
   * Última posição dos entregadores com entrega em rota agora, com
   * nome/basename da foto resolvidos — `GET /manager/deliveries/locations`.
   * `photoPath` sai CRU (basename); a URL pública é do use case.
   */
  listOnRoute(): Promise<
    Array<{
      courierId: Id;
      courierName: string | null;
      photoPath: string | null;
      latitude: number;
      longitude: number;
      updatedAt: string;
    }>
  >;
}

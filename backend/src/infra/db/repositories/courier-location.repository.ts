import { eq } from "drizzle-orm";
import type { Tx } from "../client.js";
import { courierLocations, deliveries, users } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import type { CourierLocationRecord, CourierLocationRepository, Id } from "../../../application/ports/repositories.js";

// =====================================================================
// Localização do entregador — ADIÇÃO (Onda 3 — self-service)
// =====================================================================

function toCourierLocationRecord(r: typeof courierLocations.$inferSelect): CourierLocationRecord {
  return {
    courierId: r.courierId,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracy: r.accuracy,
    updatedAt: r.updatedAt,
  };
}

export class PostgresCourierLocationRepository implements CourierLocationRepository {
  constructor(private readonly tx: Tx) {}

  /** Upsert por courier — a última posição é a única que interessa (SEM histórico). */
  async upsert(input: {
    courierId: Id;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    updatedAt: string;
  }): Promise<CourierLocationRecord> {
    const [row] = await this.tx
      .insert(courierLocations)
      .values({
        courierId: input.courierId,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: courierLocations.courierId,
        set: {
          latitude: input.latitude,
          longitude: input.longitude,
          accuracy: input.accuracy,
          updatedAt: input.updatedAt,
        },
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "courierId" });
    return toCourierLocationRecord(row);
  }

  /**
   * Join a partir da `delivery` em rota (fonte da verdade do "em rota"), não
   * da `courier_location`: um entregador que terminou a rota mantém a linha,
   * mas não deve aparecer no mapa. `photoPath` sai CRU (a URL é do use case).
   */
  async listOnRoute(): Promise<
    Array<{
      courierId: Id;
      courierName: string | null;
      photoPath: string | null;
      latitude: number;
      longitude: number;
      updatedAt: string;
    }>
  > {
    const rows = await this.tx
      .select({
        courierId: courierLocations.courierId,
        courierName: users.name,
        photoPath: users.photoPath,
        latitude: courierLocations.latitude,
        longitude: courierLocations.longitude,
        updatedAt: courierLocations.updatedAt,
      })
      .from(deliveries)
      .innerJoin(courierLocations, eq(courierLocations.courierId, deliveries.courierId))
      .innerJoin(users, eq(users.id, deliveries.courierId))
      .where(eq(deliveries.status, "out_for_delivery"));
    return rows;
  }
}


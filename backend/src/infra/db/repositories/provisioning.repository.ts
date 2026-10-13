import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { Tx } from "../client.js";
import { provisioningKeys, userDevices } from "../schema.js";
import type {
  Id,
  ProvisioningKeyRecord,
  ProvisioningKeyRepository,
  UserDeviceRecord,
  UserDeviceRepository,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Device provisioning (docs/21) — `provisioning_key` e `user_device`
// =====================================================================

/**
 * Adapter do port `ProvisioningKeyRepository`. Réplica exata das queries de
 * `provisioning.usecases.ts`: rotação revoga a ativa anterior e o insert da
 * nova usa `ON CONFLICT DO NOTHING` (o índice único parcial
 * `uq_provisioning_key_active` garante o "no máximo 1 ativa"; o perdedor da
 * corrida recebe `null`).
 */
export class PostgresProvisioningKeyRepository implements ProvisioningKeyRepository {
  constructor(private readonly tx: Tx) {}

  async revokeActive(userId: Id, at: string): Promise<void> {
    await this.tx
      .update(provisioningKeys)
      .set({ revokedAt: at, updatedAt: at })
      .where(and(eq(provisioningKeys.userId, userId), isNull(provisioningKeys.revokedAt)));
  }

  async create(input: {
    userId: Id;
    codeHash: string;
    codeHint: string;
    createdBy: Id | null;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<ProvisioningKeyRecord | null> {
    const [created] = await this.tx
      .insert(provisioningKeys)
      .values({
        userId: input.userId,
        codeHash: input.codeHash,
        codeHint: input.codeHint,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      })
      .onConflictDoNothing()
      .returning();
    return created ?? null;
  }

  async listCandidates(cutoff: string): Promise<ProvisioningKeyRecord[]> {
    return this.tx
      .select()
      .from(provisioningKeys)
      .where(
        and(
          or(isNull(provisioningKeys.revokedAt), gt(provisioningKeys.revokedAt, cutoff)),
          or(isNull(provisioningKeys.expiresAt), gt(provisioningKeys.expiresAt, cutoff)),
        ),
      );
  }
}

export class PostgresUserDeviceRepository implements UserDeviceRepository {
  constructor(private readonly tx: Tx) {}

  async revokeAll(userId: Id, at: string): Promise<number> {
    const rows = await this.tx
      .update(userDevices)
      .set({ active: false, revokedAt: at, updatedAt: at })
      .where(and(eq(userDevices.userId, userId), eq(userDevices.active, true)))
      .returning({ id: userDevices.id });
    return rows.length;
  }

  async create(input: {
    userId: Id;
    provisioningKeyId: Id | null;
    label: string | null;
    platform: string;
    appProfile: string;
    deviceSecretHash: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<UserDeviceRecord> {
    const [created] = await this.tx
      .insert(userDevices)
      .values({
        userId: input.userId,
        provisioningKeyId: input.provisioningKeyId,
        label: input.label,
        platform: input.platform,
        appProfile: input.appProfile,
        deviceSecretHash: input.deviceSecretHash,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      })
      .returning();
    return created;
  }

  async findById(id: Id): Promise<UserDeviceRecord | null> {
    const [dev] = await this.tx.select().from(userDevices).where(eq(userDevices.id, id));
    return dev ?? null;
  }

  async rotateToken(
    id: Id,
    patch: { deviceSecretHash: string; lastSeenAt: string; updatedAt: string },
  ): Promise<boolean> {
    const rows = await this.tx
      .update(userDevices)
      .set(patch)
      .where(and(eq(userDevices.id, id), eq(userDevices.active, true)))
      .returning({ id: userDevices.id });
    return rows.length > 0;
  }

  async touchLastSeen(id: Id, at: string): Promise<void> {
    await this.tx
      .update(userDevices)
      .set({ lastSeenAt: at, updatedAt: at })
      .where(and(eq(userDevices.id, id), eq(userDevices.active, true)));
  }

  async listByUser(userId: Id): Promise<UserDeviceRecord[]> {
    return this.tx
      .select()
      .from(userDevices)
      .where(eq(userDevices.userId, userId))
      .orderBy(desc(userDevices.createdAt));
  }

  async revoke(id: Id, at: string): Promise<void> {
    await this.tx
      .update(userDevices)
      .set({ active: false, revokedAt: at, updatedAt: at })
      .where(and(eq(userDevices.id, id), eq(userDevices.active, true)));
  }
}

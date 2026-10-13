import { count, desc, eq } from "drizzle-orm";
import type { Tx } from "../client.js";
import { auditLog, users } from "../schema.js";
import { SYSTEM_USER_ID } from "../../../domain/constants.js";
import type { AuditLogEntry, AuditRepository, AuditWriter, Id } from "../../../application/ports/repositories.js";

// =====================================================================
// Audit log (espelha `logAction`)
// =====================================================================

export class PostgresAuditWriter implements AuditWriter {
  constructor(private readonly tx: Tx) {}

  /**
   * `audit_log` não tem colunas `entity_type`/`entity_id` (a spec os previa):
   * aqui eles são FOLDADOS no JSON de `details`, e `actorId: null` vira o
   * usuário técnico `system` (a coluna `user_id` é NOT NULL + FK — mesmo
   * destino que os eventos self-service já usam hoje).
   */
  async record(input: {
    actorId: Id | null;
    action: string;
    entityType?: string;
    entityId?: Id | null;
    orderId?: Id | null;
    details?: unknown;
  }): Promise<void> {
    const details: Record<string, unknown> =
      input.details !== null && typeof input.details === "object" && !Array.isArray(input.details)
        ? { ...(input.details as Record<string, unknown>) }
        : input.details !== undefined
          ? { details: input.details }
          : {};
    if (input.entityType !== undefined) details.entityType = input.entityType;
    if (input.entityId !== undefined && input.entityId !== null) details.entityId = input.entityId;

    await this.tx.insert(auditLog).values({
      userId: input.actorId ?? SYSTEM_USER_ID,
      action: input.action,
      orderId: input.orderId ?? null,
      details: JSON.stringify(details),
    });
  }
}

// =====================================================================
// Audit log — leitura (`listAuditLogUsecase` / `GET /audit-log`)
// =====================================================================

/**
 * Réplica de `listAuditLogUsecase`: join com `user` para o nome, filtro
 * opcional por `order_id`, ordem decrescente por criação e contagem total
 * (a paginação é `limit`/`offset`, não cursor).
 */
export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly tx: Tx) {}

  async list(input: { orderId?: Id; limit: number; offset: number }): Promise<{ data: AuditLogEntry[]; total: number }> {
    const where = input.orderId ? eq(auditLog.orderId, input.orderId) : undefined;
    const rows = await this.tx
      .select({ log: auditLog, userName: users.name })
      .from(auditLog)
      .innerJoin(users, eq(users.id, auditLog.userId))
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    const data = rows.map(({ log, userName }) => ({
      id: log.id,
      userId: log.userId,
      userName,
      action: log.action,
      orderId: log.orderId,
      details: JSON.parse(log.details),
      createdAt: log.createdAt,
    }));

    const totalRow = await this.tx.select({ count: count() }).from(auditLog).where(where);
    return { data, total: totalRow[0]?.count ?? data.length };
  }
}


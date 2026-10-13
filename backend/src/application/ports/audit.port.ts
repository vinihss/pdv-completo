import type { EntityId, JsonValue } from "./persistence.js";

export interface AuditEntry {
  actorId: EntityId | null;
  action: string;
  entityType: string;
  entityId: EntityId | null;
  details?: JsonValue;
}

/** Escrita deve compartilhar a transação da TenantSession quando chamada nela. */
export interface AuditWriter {
  record(entry: AuditEntry): Promise<void>;
}

export interface AuditLogReader {
  list(query: { limit: number; cursor?: string; actorId?: EntityId }): Promise<{
    items: Array<AuditEntry & { id: EntityId; createdAt: string }>;
    nextCursor: string | null;
  }>;
}

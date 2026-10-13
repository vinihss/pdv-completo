/**
 * Port de auditoria — escrita transacional (`AuditWriter.record`) e a leitura
 * paginada da trilha (`AuditRepository`, Onda 3B).
 *
 * NOTA SOBRE O `AuditWriter` (adaptação ao modelo real): a spec original
 * previa `AuditWriter.record({ actorId, action, entityType, entityId,
 * details })`, mas o código real do repositório usa `logAction(tx, userId,
 * action, orderId, details)`. Para não perder informação na tradução, o port
 * acrescenta `orderId?: Id | null` (coluna real `audit_log.order_id`; sem ela,
 * o audit de eventos de comanda ficaria órfão). O adapter traduz 1:1.
 *
 * Contrato CONGELADO: os use cases falam com estas interfaces; o adapter
 * Postgres (`src/infra/db/repositories/audit.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id, Json } from "./shared.js";

/** Linha de `audit_log` já enriquecida com o nome do usuário (join com `user`). */
export interface AuditLogEntry {
  id: Id;
  userId: Id;
  userName: string;
  action: string;
  orderId: Id | null;
  details: Json;
  createdAt: string;
}

/**
 * Leitura da trilha de auditoria (`GET /audit-log`). A escrita continua em
 * `AuditWriter.record` — aqui é só a consulta paginada (Onda 3B).
 */
export interface AuditRepository {
  list(input: { orderId?: Id; limit: number; offset: number }): Promise<{ data: AuditLogEntry[]; total: number }>;
}

export interface AuditWriter {
  record(input: {
    actorId: Id | null;
    action: string;
    entityType?: string;
    entityId?: Id | null;
    /** ADIÇÃO ao spec: coluna real `audit_log.order_id` (ver nota no topo). */
    orderId?: Id | null;
    details?: Json;
  }): Promise<void>;
}

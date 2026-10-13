import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { alerts } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import { alertUserToken } from "../../../application/alert/alert.usecases.js";
import type { AlertRecord, AlertRepository, Id } from "../../../application/ports/repositories.js";

// =====================================================================
// Alertas (sino) — ADIÇÃO (Onda 2)
// =====================================================================

/**
 * Recorte de visibilidade do sino — MESMO predicado da função `visibleTo`
 * original (auditada em `alert.usecases.ts`): audiência vazia (NULL) ou
 * cardinalidade 0 é para todos; senão, o papel (e/ou o token `user:<id>` de
 * quem pergunta) precisa estar na lista. O `mark-read` usa o mesmo WHERE —
 * se divergissem, o "marcar todas" do garçom limparia o contador do gerente.
 */
function alertVisibleTo(role: string, userId?: string | null): SQL {
  const tokens = userId ? [role, alertUserToken(userId)] : [role];
  return or(
    isNull(alerts.audienceRoles),
    sql`cardinality(${alerts.audienceRoles}) = 0`,
    ...tokens.map((token) => sql`${token} = ANY(${alerts.audienceRoles})`),
  )!;
}

function toAlertRecord(r: typeof alerts.$inferSelect): AlertRecord {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    orderId: r.orderId,
    channel: r.channel,
    audienceRoles: r.audienceRoles,
    readAt: r.readAt,
    createdAt: r.createdAt,
  };
}

export class PostgresAlertRepository implements AlertRepository {
  constructor(private readonly tx: Tx) {}

  async create(input: {
    kind: string;
    title: string;
    body?: string | null;
    orderId?: Id | null;
    channel?: string | null;
    audienceRoles: string[];
  }): Promise<AlertRecord> {
    const [row] = await this.tx
      .insert(alerts)
      .values({
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        orderId: input.orderId ?? null,
        channel: input.channel ?? null,
        audienceRoles: input.audienceRoles,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "title" });
    return toAlertRecord(row);
  }

  async listVisible(query: {
    role: string;
    userId?: Id | null;
    limit: number;
    unreadOnly?: boolean;
  }): Promise<AlertRecord[]> {
    const conditions: SQL[] = [alertVisibleTo(query.role, query.userId)];
    if (query.unreadOnly) conditions.push(isNull(alerts.readAt));
    const rows = await this.tx.query.alerts.findMany({
      where: and(...conditions),
      orderBy: [desc(alerts.createdAt), desc(alerts.seq)],
      limit: query.limit,
    });
    return rows.map(toAlertRecord);
  }

  async countVisible(query: { role: string; userId?: Id | null }): Promise<{ total: number; unread: number }> {
    const [counts] = await this.tx
      .select({
        total: sql<number>`count(*)::int`,
        unread: sql<number>`count(*) filter (where ${alerts.readAt} is null)::int`,
      })
      .from(alerts)
      .where(alertVisibleTo(query.role, query.userId));
    return { total: counts?.total ?? 0, unread: counts?.unread ?? 0 };
  }

  async markRead(query: { role: string; userId?: Id | null; orderId?: Id }): Promise<number> {
    const conditions: SQL[] = [alertVisibleTo(query.role, query.userId), isNull(alerts.readAt)];
    if (query.orderId) conditions.push(eq(alerts.orderId, query.orderId));
    const marked = await this.tx
      .update(alerts)
      .set({ readAt: new Date().toISOString() })
      .where(and(...conditions))
      .returning({ id: alerts.id });
    return marked.length;
  }
}


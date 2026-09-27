import { count, eq, sql } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { auditLog, users } from "../infra/db/schema.js";

export async function listAuditLogUsecase(input: { orderId?: string; limit: number; offset: number }) {
  const where = input.orderId ? eq(auditLog.orderId, input.orderId) : undefined;
  const rows = await db
    .select({ log: auditLog, userName: users.name })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .where(where as any)
    .orderBy(sql`${auditLog.createdAt} DESC`)
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

  const totalRow = await db.select({ count: count() }).from(auditLog).where(where as any);
  return { data, total: totalRow[0]?.count ?? data.length };
}

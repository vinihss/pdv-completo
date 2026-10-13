import { count, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { suppliers } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import type { Id, Page, SupplierRecord, SupplierRepository } from "../../../application/ports/repositories.js";

// =====================================================================
// Fornecedores
// =====================================================================

function toSupplierRecord(s: typeof suppliers.$inferSelect): SupplierRecord {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    taxId: s.taxId,
    active: s.active,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export class PostgresSupplierRepository implements SupplierRepository {
  constructor(private readonly tx: Tx) {}

  /** `GET /suppliers` — `active_only`, `name ASC`, paginação + total. */
  async list(query: { activeOnly?: boolean; limit: number; offset: number }): Promise<Page<SupplierRecord>> {
    const where = query.activeOnly ? eq(suppliers.active, true) : undefined;
    const rows = await this.tx.query.suppliers.findMany({
      where,
      limit: query.limit,
      offset: query.offset,
      orderBy: (s, { asc: asc_ }) => asc_(s.name),
    });
    const totalRow = await this.tx.select({ count: count() }).from(suppliers).where(where);
    return { data: rows.map(toSupplierRecord), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  async findById(id: Id): Promise<SupplierRecord | null> {
    const row = await this.tx.query.suppliers.findFirst({ where: eq(suppliers.id, id) });
    return row ? toSupplierRecord(row) : null;
  }

  async create(input: { name: string; phone?: string | null; taxId?: string | null }): Promise<SupplierRecord> {
    const [row] = await this.tx
      .insert(suppliers)
      .values({
        name: input.name,
        phone: input.phone ?? null,
        taxId: input.taxId ?? null,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return toSupplierRecord(row);
  }

  /** UPDATE dos campos resolvidos pelo use case; `updated_at` é carimbado aqui. */
  async update(
    id: Id,
    input: { name: string; phone: string | null; taxId: string | null; active: boolean },
  ): Promise<SupplierRecord> {
    const [row] = await this.tx
      .update(suppliers)
      .set({
        name: input.name,
        phone: input.phone,
        taxId: input.taxId,
        active: input.active,
        updatedAt: sql`(current_timestamp)`,
      })
      .where(eq(suppliers.id, id))
      .returning();
    if (!row) throw Errors.notFound("Fornecedor");
    return toSupplierRecord(row);
  }
}


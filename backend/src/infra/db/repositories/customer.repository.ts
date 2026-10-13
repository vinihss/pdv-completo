import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { customerAddresses, customers } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import { normalizeAccents } from "../../../domain/text.js";
import type {
  CustomerRecord,
  CustomerRepository,
  Id,
  Page,
  PageQuery,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Clientes
// =====================================================================

function toCustomerRecord(c: typeof customers.$inferSelect): CustomerRecord {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    cpf: c.cpf,
    notes: c.notes,
    photoPath: c.photoPath,
    active: c.active,
    createdAt: c.createdAt,
  };
}

// Busca da manutenção (mesma da `listCustomersUsecase`): nome/telefone/email,
// ignorando acentos e caixa. O termo já vem normalizado do use case.
function customerSearchCondition(term: string): SQL {
  const t = `%${term}%`;
  return sql`(
    unaccent(${customers.name}) ILIKE unaccent(${t})
    OR ${customers.phone} ILIKE ${t}
    OR unaccent(${customers.email}) ILIKE unaccent(${t})
  )`;
}

export class PostgresCustomerRepository implements CustomerRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<CustomerRecord | null> {
    const row = await this.tx.query.customers.findFirst({ where: eq(customers.id, id) });
    return row ? toCustomerRecord(row) : null;
  }

  /** Phone crudo como veio — normalizar dígitos é do use case (como hoje). */
  async findByPhone(phone: string): Promise<CustomerRecord | null> {
    const row = await this.tx.query.customers.findFirst({ where: eq(customers.phone, phone) });
    return row ? toCustomerRecord(row) : null;
  }

  async list(query: PageQuery & { search?: string; active?: boolean }): Promise<Page<CustomerRecord>> {
    const conditions: SQL[] = [];
    if (query.search?.trim()) conditions.push(customerSearchCondition(normalizeAccents(query.search.trim())));
    if (query.active !== undefined) conditions.push(eq(customers.active, query.active));
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.tx.query.customers.findMany({
      where,
      orderBy: (c, { asc: asc_ }) => asc_(c.name),
      limit: query.limit,
      offset: query.offset,
    });
    const totalRow = await this.tx.select({ count: count() }).from(customers).where(where);
    return { data: rows.map(toCustomerRecord), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  /**
   * Create/update. Normalizações (phone dígitos, email lowercase, CPF crudo)
   * e unicidade (email/CPF com 400) continuam no use case migrado — aqui vale
   * o que o banco aceita + as unique indexes `uq_customer_email`/`uq_customer_cpf`.
   */
  async save(input: Partial<CustomerRecord> & Pick<CustomerRecord, "name">): Promise<CustomerRecord> {
    if (input.id) {
      const [row] = await this.tx
        .update(customers)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.cpf !== undefined ? { cpf: input.cpf } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.photoPath !== undefined ? { photoPath: input.photoPath } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        })
        .where(eq(customers.id, input.id))
        .returning();
      if (!row) throw Errors.notFound("Cliente");
      return toCustomerRecord(row);
    }

    const [row] = await this.tx
      .insert(customers)
      .values({
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        cpf: input.cpf ?? null,
        notes: input.notes ?? null,
        photoPath: input.photoPath ?? null,
        active: input.active ?? true,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return toCustomerRecord(row);
  }

  /** Soft-delete: histórico de pedidos impede remoção física (como o sistema faz hoje). */
  async delete(id: Id): Promise<void> {
    const [row] = await this.tx
      .update(customers)
      .set({ active: false })
      .where(eq(customers.id, id))
      .returning({ id: customers.id });
    if (!row) throw Errors.notFound("Cliente");
  }

  /** ADIÇÃO (Onda 2): lote por ids — hidratação da listagem de comandas sem N+1. */
  async findByIds(ids: Id[]): Promise<CustomerRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.query.customers.findMany({ where: inArray(customers.id, ids) });
    return rows.map(toCustomerRecord);
  }

  // ---------- ADIÇÕES (Onda 3C — customer.usecases) ----------

  /** Email exato — a unicidade (400 no use case) é o `uq_customer_email`. */
  async findByEmail(email: string): Promise<CustomerRecord | null> {
    const row = await this.tx.query.customers.findFirst({ where: eq(customers.email, email) });
    return row ? toCustomerRecord(row) : null;
  }

  /** CPF exato — a unicidade (400 no use case) é o `uq_customer_cpf`. */
  async findByCpf(cpf: string): Promise<CustomerRecord | null> {
    const row = await this.tx.query.customers.findFirst({ where: eq(customers.cpf, cpf) });
    return row ? toCustomerRecord(row) : null;
  }

  /**
   * Busca leve do balcão — só ATIVOS, ordem alfabética, LIMIT 20, superfície
   * mínima (id/nome/phone). Mesma régua da antiga `searchCustomersUsecase`.
   */
  async searchLight(search?: string): Promise<Array<Pick<CustomerRecord, "id" | "name" | "phone">>> {
    const conditions: SQL[] = [eq(customers.active, true)];
    if (search?.trim()) conditions.push(customerSearchCondition(normalizeAccents(search.trim())));
    const rows = await this.tx.query.customers.findMany({
      where: and(...conditions),
      orderBy: (c, { asc: asc_ }) => asc_(c.name),
      limit: 20,
    });
    return rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null }));
  }

  /**
   * Contagem de endereços dos clientes da PÁGINA em uma query agrupada —
   * corrige o TODO do original (o GROUP BY global, sem `where`, era O(base)
   * mesmo quando a listagem devolvia 20 linhas). `customer_id IN (ids)` dá o
   * mesmo resultado observável para as linhas da página.
   */
  async countAddressesByCustomer(customerIds: Id[]): Promise<Map<Id, number>> {
    const map = new Map<Id, number>();
    if (customerIds.length === 0) return map;
    const rows = await this.tx
      .select({ customerId: customerAddresses.customerId, count: sql<number>`count(*)` })
      .from(customerAddresses)
      .where(inArray(customerAddresses.customerId, customerIds))
      .groupBy(customerAddresses.customerId);
    for (const r of rows) map.set(r.customerId, Number(r.count));
    return map;
  }
}


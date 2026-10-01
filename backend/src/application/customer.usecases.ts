import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { customers, customerAddresses } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { logAction } from "../infra/audit-log.js";
import { normalizeAccents } from "../domain/text.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed)) throw Errors.validationFailed({ field: "email" });
  return trimmed.toLowerCase();
}

function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 8 || digits.length > 15) throw Errors.validationFailed({ field: "phone" });
  return digits;
}

function serialize(c: typeof customers.$inferSelect, addressCount = 0) {
  return { id: c.id, name: c.name, phone: c.phone ?? null, email: c.email ?? null, active: c.active, addressCount, createdAt: c.createdAt };
}

// Busca ignorando acentos (unaccent no banco + termo normalizado no app) e
// case (ILIKE). Telefone e email entram na busca — o balcão costuma achar o
// cliente por qualquer um dos três.
function searchCondition(term: string): SQL {
  const t = `%${term}%`;
  return sql`(
    unaccent(${customers.name}) ILIKE unaccent(${t})
    OR ${customers.phone} ILIKE ${t}
    OR unaccent(${customers.email}) ILIKE unaccent(${t})
  )`;
}

// Busca leve do garçom (abrir comanda com cliente): só ativos, sem email —
// a manutenção completa é a rota paginada, restrita a gerente/caixa.
export async function searchCustomersUsecase(search?: string) {
  const conditions: SQL[] = [eq(customers.active, true)];
  if (search?.trim()) conditions.push(searchCondition(normalizeAccents(search.trim())));
  const rows = await db.query.customers.findMany({
    where: and(...conditions),
    orderBy: (c, { asc }) => asc(c.name),
    limit: 20,
  });
  return rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null }));
}

export async function listCustomersUsecase(input: { search?: string; active?: boolean; limit: number; offset: number }) {
  const conditions: SQL[] = [];
  if (input.active !== undefined) conditions.push(eq(customers.active, input.active));
  if (input.search?.trim()) conditions.push(searchCondition(normalizeAccents(input.search.trim())));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db.query.customers.findMany({
    where,
    orderBy: (c, { asc }) => asc(c.name),
    limit: input.limit,
    offset: input.offset,
  });
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(customers).where(where);

  // Contagem de endereços em lote (evita N+1 na listagem).
  const counts = await db
    .select({ customerId: customerAddresses.customerId, count: sql<number>`count(*)` })
    .from(customerAddresses)
    .groupBy(customerAddresses.customerId);
  const countMap = new Map(counts.map((r) => [r.customerId, Number(r.count)]));

  return { data: rows.map((c) => serialize(c, countMap.get(c.id) ?? 0)), total: Number(totalRow[0]?.count ?? rows.length) };
}

export async function getCustomerDetailUsecase(id: string) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!customer) throw Errors.notFound("Cliente");
  const addresses = await db.query.customerAddresses.findMany({
    where: eq(customerAddresses.customerId, customer.id),
    orderBy: (a, { asc }) => asc(a.createdAt),
  });
  return {
    ...serialize(customer),
    addresses: addresses.map((a) => ({
      id: a.id,
      label: a.label ?? null,
      cep: a.cep ?? null,
      street: a.street,
      number: a.number,
      complement: a.complement ?? null,
      neighborhood: a.neighborhood,
      city: a.city,
      reference: a.reference ?? null,
      isDefault: a.isDefault,
    })),
  };
}

async function assertEmailAvailable(email: string | null | undefined, exceptCustomerId?: string) {
  if (!email) return;
  const clash = await db.query.customers.findFirst({ where: eq(customers.email, email) });
  if (clash && clash.id !== exceptCustomerId) throw Errors.validationFailed({ field: "email", reason: "email já cadastrado" });
}

export async function createCustomerUsecase(
  input: { name: string; phone?: string | null; email?: string | null },
  actorId: string
) {
  const email = normalizeEmail(input.email);
  await assertEmailAvailable(email);
  const phone = normalizePhone(input.phone);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(customers).values({ name: input.name, phone, email }).returning();
    await logAction(tx, actorId, "customer_created", null, { customerId: row.id, name: row.name });
    return row;
  });
  return serialize(created);
}

export async function updateCustomerUsecase(
  id: string,
  input: { name?: string; phone?: string | null; email?: string | null; active?: boolean },
  actorId: string
) {
  const existing = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!existing) throw Errors.notFound("Cliente");

  const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
  if (input.email !== undefined) await assertEmailAvailable(email, id);
  const phone = input.phone !== undefined ? normalizePhone(input.phone) : undefined;

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(customers)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(customers.id, id))
      .returning();
    await logAction(tx, actorId, input.active === false ? "customer_deactivated" : input.active === true ? "customer_reactivated" : "customer_updated", null, {
      customerId: id,
      name: row.name,
    });
    return row;
  });
  return serialize(updated);
}

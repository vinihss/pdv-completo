import { db } from "../../src/infra/db/client.js";
import { customers } from "../../src/infra/db/schema.js";

type InsertCustomer = typeof customers.$inferInsert;
type SelectCustomer = typeof customers.$inferSelect;

export async function createCustomer(overrides: Partial<InsertCustomer> = {}): Promise<SelectCustomer> {
  const id = overrides.id ?? `cust-${crypto.randomUUID()}`;
  const customer: InsertCustomer = {
    id,
    name: overrides.name ?? `Cliente ${id.slice(-4)}`,
    phone: overrides.phone ?? `119${Math.floor(10000000 + Math.random() * 90000000)}`,
    email: overrides.email ?? `cliente_${id.slice(-6)}@teste.com`,
    active: overrides.active ?? true,
    ...overrides,
  };

  await db
    .insert(customers)
    .values(customer)
    .onConflictDoUpdate({
      target: [customers.tenantId, customers.id],
      set: customer,
    });

  return customer as SelectCustomer;
}

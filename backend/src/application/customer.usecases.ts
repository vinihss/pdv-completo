import { or, like } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { customers } from "../infra/db/schema.js";

export async function searchCustomersUsecase(search?: string) {
  if (!search) {
    return db.query.customers.findMany({ orderBy: (c, { asc }) => asc(c.name), limit: 20 });
  }
  const term = `%${search}%`;
  return db.query.customers.findMany({
    where: or(like(customers.name, term), like(customers.phone, term)),
    orderBy: (c, { asc }) => asc(c.name),
    limit: 20,
  });
}

export async function createCustomerUsecase(input: { name: string; phone?: string }) {
  const [created] = await db.insert(customers).values({ name: input.name, phone: input.phone ?? null }).returning();
  return created;
}

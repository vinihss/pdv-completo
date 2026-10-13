import { db } from "../../src/infra/db/client.js";
import { restaurantTables } from "../../src/infra/db/schema.js";

type InsertTable = typeof restaurantTables.$inferInsert;
type SelectTable = typeof restaurantTables.$inferSelect;

export async function createTable(overrides: Partial<InsertTable> = {}): Promise<SelectTable> {
  const id = overrides.id ?? `t-${crypto.randomUUID()}`;
  const table: InsertTable = {
    id,
    number: overrides.number ?? `${Math.floor(Math.random() * 900) + 100}`,
    status: overrides.status ?? "free",
    capacity: overrides.capacity ?? 4,
    active: overrides.active ?? true,
    ...overrides,
  };

  await db
    .insert(restaurantTables)
    .values(table)
    .onConflictDoUpdate({
      target: restaurantTables.id,
      set: table,
    });

  return table as SelectTable;
}

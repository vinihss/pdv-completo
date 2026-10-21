import { db } from "../../src/infra/db/client.js";
import { cashDrawers } from "../../src/infra/db/schema.js";
import { createCashier } from "./user.factory.js";

type InsertCashDrawer = typeof cashDrawers.$inferInsert;
type SelectCashDrawer = typeof cashDrawers.$inferSelect;

export async function createCashDrawer(overrides: Partial<InsertCashDrawer> = {}): Promise<SelectCashDrawer> {
  const id = overrides.id ?? `drawer-${crypto.randomUUID()}`;

  let openedBy = overrides.openedBy;
  if (!openedBy) {
    const cashier = await createCashier({ id: `u-cashier-${id.slice(-6)}` });
    openedBy = cashier.id;
  }

  const drawer: InsertCashDrawer = {
    id,
    openedBy,
    status: overrides.status ?? "open",
    openingAmount: overrides.openingAmount ?? 100.0,
    note: overrides.note,
    ...overrides,
  };

  await db
    .insert(cashDrawers)
    .values(drawer)
    .onConflictDoUpdate({
      target: [cashDrawers.tenantId, cashDrawers.id],
      set: drawer,
    });

  return drawer as SelectCashDrawer;
}

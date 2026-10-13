import { db } from "../../src/infra/db/client.js";
import { kitchenGroups } from "../../src/infra/db/schema.js";

type InsertKitchenGroup = typeof kitchenGroups.$inferInsert;
type SelectKitchenGroup = typeof kitchenGroups.$inferSelect;

export async function createKitchenGroup(overrides: Partial<InsertKitchenGroup> = {}): Promise<SelectKitchenGroup> {
  const id = overrides.id ?? `kg-${crypto.randomUUID()}`;
  const group: InsertKitchenGroup = {
    id,
    name: overrides.name ?? "Cozinha",
    displayOrder: overrides.displayOrder ?? 0,
    active: overrides.active ?? true,
    ...overrides,
  };

  await db
    .insert(kitchenGroups)
    .values(group)
    .onConflictDoUpdate({
      target: kitchenGroups.id,
      set: group,
    });

  return group as SelectKitchenGroup;
}

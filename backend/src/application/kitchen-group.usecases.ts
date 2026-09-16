import { eq } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { kitchenGroups, products } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { logAction } from "../infra/audit-log.js";

export async function listKitchenGroupsUsecase() {
  return db.query.kitchenGroups.findMany({ orderBy: (g, { asc }) => asc(g.displayOrder) });
}

export async function createKitchenGroupUsecase(
  input: { name: string; displayOrder?: number },
  actorId: string
) {
  return db.transaction((tx) => {
    const row = tx
      .insert(kitchenGroups)
      .values({ name: input.name, displayOrder: input.displayOrder ?? 0 })
      .returning()
      .get();
    logAction(tx, actorId, "kitchen_group_created", null, { kitchenGroupId: row.id, name: row.name });
    return row;
  });
}

export async function updateKitchenGroupUsecase(
  id: string,
  input: { name?: string; displayOrder?: number; active?: boolean },
  actorId: string
) {
  const existing = await db.query.kitchenGroups.findFirst({ where: eq(kitchenGroups.id, id) });
  if (!existing) throw Errors.notFound("Grupo de produção");
  return db.transaction((tx) => {
    const row = tx
      .update(kitchenGroups)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(kitchenGroups.id, id))
      .returning()
      .get();
    logAction(tx, actorId, "kitchen_group_updated", null, { kitchenGroupId: id });
    return row;
  });
}

// Exclusão real (como categoria): produtos vinculados ficam com
// kitchen_group_id nulo (não vão mais para a cozinha) até reatribuição.
export async function deleteKitchenGroupUsecase(id: string, actorId: string) {
  const existing = await db.query.kitchenGroups.findFirst({ where: eq(kitchenGroups.id, id) });
  if (!existing) throw Errors.notFound("Grupo de produção");
  db.transaction((tx) => {
    tx.update(products).set({ kitchenGroupId: null }).where(eq(products.kitchenGroupId, id)).run();
    tx.delete(kitchenGroups).where(eq(kitchenGroups.id, id)).run();
    logAction(tx, actorId, "kitchen_group_deleted", null, { kitchenGroupId: id, name: existing.name });
  });
}
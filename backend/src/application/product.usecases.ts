import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { products, categories, kitchenGroups } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { logAction } from "../infra/audit-log.js";
import { stockBalances, currentStock, applyStockMovementTx } from "./stock/stock.usecases.js";
import { normalizeVariations, type VariationGroup } from "../domain/variations.js";
import { getCache } from "../infra/cache/index.js";
import { getStorage, isSafeFilename, storageAssetPath, storageFilename } from "../infra/storage/index.js";
import { normalizeAccents } from "../domain/text.js";

const cache = getCache();
const storage = getStorage();

function productListKey(input: {
  categoryId?: string;
  active?: boolean;
  search?: string;
  sort?: string;
  limit: number;
  offset: number;
}): string {
  return `products:list:${JSON.stringify(input)}`;
}

// Busca ignorando acentos (extensão unaccent, migration 0003) e case.
function productSearchCondition(search: string): SQL {
  const term = `%${search}%`;
  return sql`unaccent(${products.name}) ILIKE unaccent(${term})`;
}

// Re-exportado pra não quebrar os consumidores históricos (menu público,
// cadastro de produto). A implementação é pura e mora em domain/variations.ts.
export { normalizeVariations, type VariationGroup };

// Caminho HTTP da foto, relativo à raiz: /uploads/product/<id>.<ext>
function imageUrl(filename: string | null | undefined): string | null {
  return filename ? storageAssetPath("product", filename) : null;
}

// Nomes de categoria/grupo de produção para o payload — resolvidos fora do
// hot path de N+1 (listagem busca tudo de uma vez e monta mapas).
type ProductRefs = { categoryName: string | null; kitchenGroupName: string | null };

async function refsFor(categoryId: string | null, kitchenGroupId: string | null): Promise<ProductRefs> {
  const [category, group] = await Promise.all([
    categoryId ? db.query.categories.findFirst({ where: eq(categories.id, categoryId) }) : Promise.resolve(null),
    kitchenGroupId ? db.query.kitchenGroups.findFirst({ where: eq(kitchenGroups.id, kitchenGroupId) }) : Promise.resolve(null),
  ]);
  return { categoryName: category?.name ?? null, kitchenGroupName: group?.name ?? null };
}

async function serializeWithStock(row: typeof products.$inferSelect) {
  return serialize(row, await refsFor(row.categoryId, row.kitchenGroupId), await currentStock(row.id));
}

function serialize(p: typeof products.$inferSelect, refs: ProductRefs, quantity = 0) {
  return {
    id: p.id,
    categoryId: p.categoryId,
    categoryName: refs.categoryName,
    kitchenGroupId: p.kitchenGroupId,
    kitchenGroupName: refs.kitchenGroupName,
    name: p.name,
    description: p.description,
    price: p.price,
    variations: normalizeVariations(JSON.parse(p.variations)),
    imagePath: imageUrl(p.imagePath),
    ifoodEnabled: p.ifoodEnabled,
    ifoodSku: p.ifoodSku,
    featured: p.featured,
    costPrice: p.costPrice,
    lowStockThreshold: p.lowStockThreshold,
    trackStock: p.trackStock,
    unit: p.unit,
    quantity, // saldo atual do ledger (só relevante quando trackStock)
    low: p.trackStock && quantity <= p.lowStockThreshold,
    active: p.active,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function listProductsUsecase(input: {
  categoryId?: string;
  active?: boolean;
  search?: string;
  sort?: string;
  limit: number;
  offset: number;
}) {
  const key = productListKey(input);
  const cached = cache.get<{ data: unknown[]; total: number }>(key);
  if (cached) return cached;

  const conditions: SQL[] = [];
  if (input.categoryId) conditions.push(eq(products.categoryId, input.categoryId));
  if (input.active !== undefined) conditions.push(eq(products.active, input.active));
  if (input.search) conditions.push(productSearchCondition(normalizeAccents(input.search)));
  const where = conditions.length ? and(...conditions) : undefined;

  const orderBy =
    input.sort === "price_asc"
      ? asc(products.price)
      : input.sort === "price_desc"
        ? desc(products.price)
        : asc(products.name);

  const rows = await db.query.products.findMany({
    where,
    limit: input.limit,
    offset: input.offset,
    orderBy,
  });
  const totalRow = await db.select({ count: count() }).from(products).where(where as any);

  const categoryNames = await db.query.categories.findMany({ columns: { id: true, name: true } });
  const groupNames = await db.query.kitchenGroups.findMany({ columns: { id: true, name: true } });
  const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));
  const groupMap = new Map(groupNames.map((g) => [g.id, g.name]));

  const balances = await stockBalances(rows.map((p) => p.id));

  const data = rows.map((p) =>
    serialize(
      p,
      {
        categoryName: p.categoryId ? (catMap.get(p.categoryId) as string | undefined) ?? null : null,
        kitchenGroupName: p.kitchenGroupId ? (groupMap.get(p.kitchenGroupId) as string | undefined) ?? null : null,
      },
      balances.get(p.id) ?? 0
    )
  );
  const result = { data, total: totalRow[0]?.count ?? rows.length };
  cache.set(key, result, { ttl: 120 });
  return result;
}

async function assertCategoryExists(categoryId: string) {
  const category = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
  if (!category) throw Errors.validationFailed({ field: "categoryId" });
}

async function assertKitchenGroupExists(kitchenGroupId: string) {
  const group = await db.query.kitchenGroups.findFirst({ where: eq(kitchenGroups.id, kitchenGroupId) });
  if (!group) throw Errors.validationFailed({ field: "kitchenGroupId" });
}

export async function createProductUsecase(
  input: {
    categoryId: string;
    kitchenGroupId?: string | null;
    name: string;
    description?: string;
    price: number;
    variations?: unknown[];
    ifoodEnabled?: boolean;
    ifoodSku?: string | null;
    featured?: boolean;
    active?: boolean;
    costPrice?: number;
    lowStockThreshold?: number;
    trackStock?: boolean;
    unit?: string;
    initialStock?: number;
  },
  actorId: string
) {
  if (input.price < 0) throw Errors.validationFailed({ field: "price" });
  if (input.costPrice !== undefined && input.costPrice < 0) throw Errors.validationFailed({ field: "costPrice" });
  if (input.lowStockThreshold !== undefined && input.lowStockThreshold < 0)
    throw Errors.validationFailed({ field: "lowStockThreshold" });
  await assertCategoryExists(input.categoryId);
  if (input.kitchenGroupId) await assertKitchenGroupExists(input.kitchenGroupId);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(products)
      .values({
        categoryId: input.categoryId,
        kitchenGroupId: input.kitchenGroupId ?? null,
        name: input.name,
        description: input.description ?? "",
        price: input.price,
        variations: JSON.stringify(input.variations ?? []),
        ifoodEnabled: input.ifoodEnabled ?? false,
        ifoodSku: input.ifoodSku ?? null,
        featured: input.featured ?? false,
        costPrice: input.costPrice ?? 0,
        lowStockThreshold: input.lowStockThreshold ?? 0,
        trackStock: input.trackStock ?? false,
        unit: input.unit?.trim() || "un",
        active: input.active ?? true,
      })
      .returning();

    // Estoque inicial informado no cadastro vira um ajuste no ledger (mesma
    // transação — regra: escrita de domínio + audit + outbox juntos). Com
    // unit_cost = cost_price manual, vira o primeiro evento de valoração da
    // média móvel quando as compras forem habilitadas.
    if (input.trackStock && input.initialStock !== undefined && input.initialStock !== 0) {
      await applyStockMovementTx(tx, {
        productId: row.id,
        type: "adjustment",
        quantityDelta: input.initialStock,
        unitCost: input.costPrice ?? 0,
        note: "Estoque inicial",
        createdBy: actorId,
      });
    }
    await logAction(tx, actorId, "product_created", null, { productId: row.id, name: row.name });
    return row;
  });

  cache.invalidatePattern("products:*");
  return serializeWithStock(created);
}

export async function updateProductUsecase(
  id: string,
  input: {
    categoryId?: string | null;
    kitchenGroupId?: string | null;
    name?: string;
    description?: string;
    price?: number;
    variations?: unknown[];
    ifoodEnabled?: boolean;
    ifoodSku?: string | null;
    featured?: boolean;
    active?: boolean;
    costPrice?: number;
    lowStockThreshold?: number;
    trackStock?: boolean;
    unit?: string;
  },
  actorId: string
) {
  if (input.price !== undefined && input.price < 0) throw Errors.validationFailed({ field: "price" });
  if (input.costPrice !== undefined && input.costPrice < 0) throw Errors.validationFailed({ field: "costPrice" });
  if (input.lowStockThreshold !== undefined && input.lowStockThreshold < 0)
    throw Errors.validationFailed({ field: "lowStockThreshold" });
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  if (input.categoryId) await assertCategoryExists(input.categoryId);
  if (input.kitchenGroupId) await assertKitchenGroupExists(input.kitchenGroupId);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId as string | null } : {}),
        ...(input.kitchenGroupId !== undefined ? { kitchenGroupId: input.kitchenGroupId as string | null } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.variations !== undefined ? { variations: JSON.stringify(input.variations ?? []) } : {}),
        ...(input.ifoodEnabled !== undefined ? { ifoodEnabled: input.ifoodEnabled } : {}),
        ...(input.ifoodSku !== undefined ? { ifoodSku: input.ifoodSku } : {}),
        ...(input.featured !== undefined ? { featured: input.featured } : {}),
        ...(input.costPrice !== undefined ? { costPrice: input.costPrice } : {}),
        ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
        ...(input.trackStock !== undefined ? { trackStock: input.trackStock } : {}),
        ...(input.unit !== undefined ? { unit: input.unit.trim() || "un" } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(products.id, id))
      .returning();
    await logAction(tx, actorId, "product_updated", null, { productId: id, name: row.name });
    return row;
  });

  cache.invalidatePattern("products:*");
  return serializeWithStock(updated);
}

export async function setProductActiveUsecase(id: string, active: boolean, actorId: string) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({ active, updatedAt: new Date().toISOString() })
      .where(eq(products.id, id))
      .returning();
    await logAction(tx, actorId, active ? "product_activated" : "product_deactivated", null, {
      productId: id,
      name: row.name,
    });
    cache.invalidatePattern("products:*");
    return row;
  });
  return serializeWithStock(updated);
}

// ---------- Foto (upload em disco, caminho gravado em product.image_path) ----------
//
// O `storage` (infra/storage) é quem monta o caminho em disco e quem apaga o
// arquivo antigo; aqui fica só o que é regra de produto: o nome vem do id
// (o "minha-foto.png" enviado no multipart nunca vira caminho), o `image_path`
// guarda SÓ o basename e o `logAction` vai na mesma transação do UPDATE.

export async function saveProductImageUsecase(
  id: string,
  input: { buffer: Buffer; ext: string },
  actorId: string
) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");

  const filename = `${id}.${input.ext}`;
  if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "image" });
  await storage.put("product", filename, input.buffer);

  // Remove a foto antiga quando o produto trocou a extensão do arquivo
  const previous = storageFilename(existing.imagePath);
  if (previous && previous !== filename) await storage.remove("product", previous);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({ imagePath: filename, updatedAt: new Date().toISOString() })
      .where(eq(products.id, id))
      .returning();
    await logAction(tx, actorId, "product_image_changed", null, { productId: id });
    return row;
  });
  cache.invalidatePattern("products:*");
  return serializeWithStock(updated);
}

export async function clearProductImageUsecase(id: string, actorId: string) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  const previous = storageFilename(existing.imagePath);
  if (previous) await storage.remove("product", previous);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({ imagePath: null, updatedAt: new Date().toISOString() })
      .where(eq(products.id, id))
      .returning();
    await logAction(tx, actorId, "product_image_removed", null, { productId: id });
    cache.invalidatePattern("products:*");
    return row;
  });
  cache.invalidatePattern("products:*");
  return serializeWithStock(updated);
}
import { and, eq, like, sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../infra/db/client.js";
import { products, categories, kitchenGroups } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { config } from "../config/env.js";
import { logAction } from "../infra/audit-log.js";
import { stockBalances, currentStock, applyStockMovementTx } from "./stock/stock.usecases.js";

// Variações: formato estruturado de grupos (§01 backend-spec, tabela product).
//   [{ name: "Ponto da carne", options: ["Mal passado", ...], required?, allowMultiple? }]
// Arrays legados (lista plana de strings, ex. seed antigo) são normalizados na
// leitura para um único grupo "Opção" — compativel com `selectedVariations`
// persistido como Record<grupo, opção> (e opção múltipla como string[]).
export interface VariationGroup {
  name: string;
  options: string[];
  required: boolean;
  allowMultiple: boolean;
}

export function normalizeVariations(raw: unknown): VariationGroup[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Legado: ["Limão", "Morango"] → [{ name: "Opção", options: [...] }]
  if (typeof raw[0] === "string") {
    const options = (raw as unknown[])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
    return options.length ? [{ name: "Opção", options, required: false, allowMultiple: false }] : [];
  }

  return (raw as any[])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) => ({
      name: typeof g.name === "string" ? g.name.trim() : "",
      options: Array.isArray(g.options)
        ? g.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
        : [],
      required: Boolean(g.required),
      allowMultiple: Boolean(g.allowMultiple),
    }))
    .filter((g) => g.name.length > 0 && g.options.length > 0);
}

// Caminho HTTP da foto, relativo à raiz: /uploads/<id>.<ext>
function imageUrl(filename: string | null | undefined): string | null {
  return filename ? `/uploads/${filename}` : null;
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
    costPrice: p.costPrice,
    lowStockThreshold: p.lowStockThreshold,
    trackStock: p.trackStock,
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
  limit: number;
  offset: number;
}) {
  const conditions = [];
  if (input.categoryId) conditions.push(eq(products.categoryId, input.categoryId));
  if (input.active !== undefined) conditions.push(eq(products.active, input.active));
  if (input.search) conditions.push(like(products.name, `%${input.search}%`));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db.query.products.findMany({
    where,
    limit: input.limit,
    offset: input.offset,
    orderBy: (p, { asc }) => asc(p.name),
  });
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(products).where(where as any);

  const categoryNames = await db.query.categories.findMany({ columns: { id: true, name: true } });
  const groupNames = await db.query.kitchenGroups.findMany({ columns: { id: true, name: true } });
  const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));
  const groupMap = new Map(groupNames.map((g) => [g.id, g.name]));

  const balances = await stockBalances(rows.map((p) => p.id));

  const data = rows.map((p) =>
    serialize(
      p,
      {
        categoryName: p.categoryId ? catMap.get(p.categoryId) ?? null : null,
        kitchenGroupName: p.kitchenGroupId ? groupMap.get(p.kitchenGroupId) ?? null : null,
      },
      balances.get(p.id) ?? 0
    )
  );
  return { data, total: totalRow[0]?.count ?? rows.length };
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
    active?: boolean;
    costPrice?: number;
    lowStockThreshold?: number;
    trackStock?: boolean;
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

  const created = db.transaction((tx) => {
    const row = tx
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
        costPrice: input.costPrice ?? 0,
        lowStockThreshold: input.lowStockThreshold ?? 0,
        trackStock: input.trackStock ?? false,
        active: input.active ?? true,
      })
      .returning()
      .get();

    // Estoque inicial informado no cadastro vira um ajuste no ledger (mesma
    // transação — regra: escrita de domínio + audit + outbox juntos).
    if (input.trackStock && input.initialStock !== undefined && input.initialStock !== 0) {
      applyStockMovementTx(tx, {
        productId: row.id,
        type: "adjustment",
        quantityDelta: input.initialStock,
        note: "Estoque inicial",
        createdBy: actorId,
      });
    }
    logAction(tx, actorId, "product_created", null, { productId: row.id, name: row.name });
    return row;
  });

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
    active?: boolean;
    costPrice?: number;
    lowStockThreshold?: number;
    trackStock?: boolean;
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

  const updated = db.transaction((tx) => {
    const row = tx
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
        ...(input.costPrice !== undefined ? { costPrice: input.costPrice } : {}),
        ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
        ...(input.trackStock !== undefined ? { trackStock: input.trackStock } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(products.id, id))
      .returning()
      .get();
    logAction(tx, actorId, "product_updated", null, { productId: id, name: row.name });
    return row;
  });

  return serializeWithStock(updated);
}

export async function setProductActiveUsecase(id: string, active: boolean, actorId: string) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  const updated = db.transaction((tx) => {
    const row = tx
      .update(products)
      .set({ active, updatedAt: new Date().toISOString() })
      .where(eq(products.id, id))
      .returning()
      .get();
    logAction(tx, actorId, active ? "product_activated" : "product_deactivated", null, {
      productId: id,
      name: row.name,
    });
    return row;
  });
  return serializeWithStock(updated);
}

// ---------- Foto (upload em disco, caminho gravado em product.image_path) ----------

function uploadsDir(): string {
  const dir = path.resolve(config.uploadsDir);
  // Mesma convenção do client.ts (sqlite): garante que o diretório existe,
  // mesmo quando o use case roda fora do boot do servidor (testes/cron).
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function oldFileFor(row: { imagePath: string | null }): string | null {
  if (!row.imagePath) return null;
  // O banco guarda só o nome do arquivo ("<id>.<ext>"), sempre gerado por nós.
  // basename defende contra qualquer path absoluto/relativo que escape do dir.
  const filename = path.basename(row.imagePath);
  if (!filename) return null;
  return path.resolve(uploadsDir(), filename);
}

function removeFile(fullPath: string | null) {
  if (!fullPath) return;
  try {
    fs.unlinkSync(fullPath);
  } catch {
    // arquivo já removido ou inexistente — foto órfã não impede nada
  }
}

export async function saveProductImageUsecase(
  id: string,
  input: { buffer: Buffer; ext: string },
  actorId: string
) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");

  const filename = `${id}.${input.ext}`;
  const target = path.resolve(uploadsDir(), filename);
  if (!target.startsWith(uploadsDir())) {
    throw Errors.validationFailed({ field: "image" });
  }
  fs.writeFileSync(target, input.buffer);

  // Remove a foto antiga quando o produto trocou a extensão do arquivo
  const previous = oldFileFor(existing);
  if (previous && previous !== target) removeFile(previous);

  const updated = db.transaction((tx) => {
    const row = tx
      .update(products)
      .set({ imagePath: filename, updatedAt: new Date().toISOString() })
      .where(eq(products.id, id))
      .returning()
      .get();
    logAction(tx, actorId, "product_image_changed", null, { productId: id });
    return row;
  });
  return serializeWithStock(updated);
}

export async function clearProductImageUsecase(id: string, actorId: string) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  removeFile(oldFileFor(existing));
  const updated = db.transaction((tx) => {
    const row = tx
      .update(products)
      .set({ imagePath: null, updatedAt: new Date().toISOString() })
      .where(eq(products.id, id))
      .returning()
      .get();
    logAction(tx, actorId, "product_image_removed", null, { productId: id });
    return row;
  });
  return serializeWithStock(updated);
}
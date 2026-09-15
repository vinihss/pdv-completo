import { and, eq, sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../infra/db/client.js";
import { products } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { config } from "../config/env.js";

// Caminho HTTP da foto, relativo à raiz: /uploads/<id>.<ext>
function imageUrl(filename: string | null | undefined): string | null {
  return filename ? `/uploads/${filename}` : null;
}

function serialize(p: typeof products.$inferSelect) {
  return {
    id: p.id,
    categoryId: p.categoryId,
    name: p.name,
    description: p.description,
    price: p.price,
    variations: JSON.parse(p.variations),
    imagePath: imageUrl(p.imagePath),
    ifoodEnabled: p.ifoodEnabled,
    ifoodSku: p.ifoodSku,
    active: p.active,
    createdAt: p.createdAt,
  };
}

export async function listProductsUsecase(input: {
  categoryId?: string;
  active?: boolean;
  limit: number;
  offset: number;
}) {
  const conditions = [];
  if (input.categoryId) conditions.push(eq(products.categoryId, input.categoryId));
  if (input.active !== undefined) conditions.push(eq(products.active, input.active));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db.query.products.findMany({
    where,
    limit: input.limit,
    offset: input.offset,
    orderBy: (p, { asc }) => asc(p.name),
  });
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(products).where(where as any);
  return { data: rows.map(serialize), total: totalRow[0]?.count ?? rows.length };
}

export async function createProductUsecase(input: {
  categoryId: string;
  name: string;
  description?: string;
  price: number;
  variations?: unknown[];
  ifoodEnabled?: boolean;
  ifoodSku?: string | null;
}) {
  if (input.price < 0) throw Errors.validationFailed({ field: "price" });
  const [created] = await db
    .insert(products)
    .values({
      categoryId: input.categoryId,
      name: input.name,
      description: input.description ?? "",
      price: input.price,
      variations: JSON.stringify(input.variations ?? []),
      ifoodEnabled: input.ifoodEnabled ?? false,
      ifoodSku: input.ifoodSku ?? null,
    })
    .returning();
  return serialize(created);
}

export async function updateProductUsecase(
  id: string,
  input: {
    categoryId?: string;
    name?: string;
    description?: string;
    price?: number;
    variations?: unknown[];
    ifoodEnabled?: boolean;
    ifoodSku?: string | null;
  }
) {
  if (input.price !== undefined && input.price < 0) throw Errors.validationFailed({ field: "price" });
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");

  const [updated] = await db
    .update(products)
    .set({
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.variations !== undefined ? { variations: JSON.stringify(input.variations) } : {}),
      ...(input.ifoodEnabled !== undefined ? { ifoodEnabled: input.ifoodEnabled } : {}),
      ...(input.ifoodSku !== undefined ? { ifoodSku: input.ifoodSku } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(products.id, id))
    .returning();
  return serialize(updated);
}

export async function setProductActiveUsecase(id: string, active: boolean) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  const [updated] = await db
    .update(products)
    .set({ active, updatedAt: new Date().toISOString() })
    .where(eq(products.id, id))
    .returning();
  return serialize(updated);
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
  input: { buffer: Buffer; ext: string }
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

  const [updated] = await db
    .update(products)
    .set({ imagePath: filename, updatedAt: new Date().toISOString() })
    .where(eq(products.id, id))
    .returning();
  return serialize(updated);
}

export async function clearProductImageUsecase(id: string) {
  const existing = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!existing) throw Errors.notFound("Produto");
  removeFile(oldFileFor(existing));
  const [updated] = await db
    .update(products)
    .set({ imagePath: null, updatedAt: new Date().toISOString() })
    .where(eq(products.id, id))
    .returning();
  return serialize(updated);
}
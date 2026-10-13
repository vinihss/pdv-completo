/**
 * Helpers do módulo de produtos — extraídos do monolito `product.usecases.ts`
 * para serem compartilhados pelos Use Cases sem duplicação.
 *
 * Os helpers "puros" (`imageUrl`/`isSafeFilename`/`storageFilename`/
 * `serialize`) não tocam I/O. Os que recebem `TenantSession`
 * (`refsFor`/`serializeWithStock`) também são puros do ponto de vista de
 * infraestrutura: só compõem leituras do port de sessão (o I/O mora nos
 * adapters). Mantêm a MESMA lógica da versão anterior.
 */
import type { TenantSession } from "../../ports/unit-of-work.js";
import type { ProductRecord } from "../../ports/repositories.js";
import { normalizeVariations } from "../../../domain/variations.js";

/** `/uploads/product/<filename>` — mesmo formato de `storageAssetPath`. */
const UPLOADS_PREFIX = "/uploads";
function imageUrl(filename: string | null | undefined): string | null {
  return filename ? `${UPLOADS_PREFIX}/product/${filename}` : null;
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  return FILENAME_RE.test(filename);
}

/** Normaliza o que está no banco para o nome de arquivo (só o basename). */
function storageFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.split(/[\\/]/).pop() ?? null;
}

/** Nomes de categoria/grupo de produção para o payload. */
export type ProductRefs = { categoryName: string | null; kitchenGroupName: string | null };

async function refsFor(
  session: TenantSession,
  categoryId: string | null,
  kitchenGroupId: string | null,
): Promise<ProductRefs> {
  const [category, group] = await Promise.all([
    categoryId ? session.catalog.findCategoryById(categoryId) : Promise.resolve(null),
    kitchenGroupId ? session.catalog.findKitchenGroupById(kitchenGroupId) : Promise.resolve(null),
  ]);
  return { categoryName: category?.name ?? null, kitchenGroupName: group?.name ?? null };
}

function serialize(p: ProductRecord, refs: ProductRefs, quantity = 0) {
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

async function serializeWithStock(session: TenantSession, row: ProductRecord) {
  const quantity = await session.stock.balance(row.id);
  return serialize(row, await refsFor(session, row.categoryId, row.kitchenGroupId), quantity);
}

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

export const ProductHelpers = {
  imageUrl,
  isSafeFilename,
  storageFilename,
  refsFor,
  serialize,
  serializeWithStock,
  productListKey,
};

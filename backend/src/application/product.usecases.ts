/**
 * Catálogo — produtos. ONDA 3A da refatoração arquitetural.
 *
 * Factory pura (`createProductUsecases`): nenhuma importação de
 * infra/Drizzle. Persistência via `session.catalog`, ledger via
 * `session.stock` (estoque inicial), audit via `session.audit`
 * (MESMA transação da escrita de domínio), cache via port
 * `TenantCache` e arquivos via port `FileStorage`.
 *
 * Semântica preservada do módulo original:
 *   - `listProductsUsecase`: cache `products:list:*` (TTL 120s),
 *     busca `unaccent ILIKE`, sorts price_asc/price_desc/nome,
 *     e N+1 evitado (categorias/grupos lidos de uma vez);
 *   - create/update: validações de preço/custo/threshold, 404 de
 *     categoria/grupo, estoque inicial → ajuste no ledger (mesma
 *     transação), audit e invalidação de `products:*`;
 *   - setProductActive: `product_activated`/`product_deactivated`;
 *   - fotos: nome = `<id>.<ext>` (o nome enviado nunca vira
 *     caminho), `image_path` guarda só o basename, arquivo antigo
 *     removido quando a extensão muda, audit na mesma transação.
 */
import type { TenantUnitOfWork, TenantSession } from "./ports/unit-of-work.js";
import type { TenantContext } from "./ports/tenant-context.js";
import type { TenantCache, FileStorage } from "./ports/effects.js";
import type { ProductRecord } from "./ports/repositories.js";
import { Errors } from "../domain/errors.js";
import { normalizeVariations, type VariationGroup } from "../domain/variations.js";
import { normalizeAccents } from "../domain/text.js";

// Re-exportado pra não quebrar os consumidores históricos (menu público,
// cadastro de produto). A implementação é pura e mora em domain/variations.ts.
export { normalizeVariations, type VariationGroup };

// ---------- helpers puros (eram infra/storage) ----------
//
// `storageAssetPath`/`isSafeFilename`/`storageFilename` são funções
// PURAS de `infra/storage` (sem I/O). Definidas aqui para a application
// não importar a camada de armazenamento — o `FileStorage` port
// (put/remove) é a única seam de I/O. Mantêm a MESMA lógica.

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
  const name = raw.split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
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

// Nomes de categoria/grupo de produção para o payload — resolvidos fora do
// hot path de N+1 (listagem busca tudo de uma vez e monta mapas).
type ProductRefs = { categoryName: string | null; kitchenGroupName: string | null };

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

async function serializeWithStock(session: TenantSession, row: ProductRecord) {
  const quantity = await session.stock.balance(row.id);
  return serialize(row, await refsFor(session, row.categoryId, row.kitchenGroupId), quantity);
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

export interface ProductUsecasesDeps {
  uow: TenantUnitOfWork;
  cache: TenantCache;
  storage: FileStorage;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

export function createProductUsecases(deps: ProductUsecasesDeps) {
  return {
    async listProductsUsecase(input: {
      categoryId?: string;
      active?: boolean;
      search?: string;
      sort?: string;
      limit: number;
      offset: number;
    }) {
      const key = productListKey(input);
      const cached = await deps.cache.get<{ data: unknown[]; total: number }>(key);
      if (cached) return cached;

      return deps.uow.run(deps.tenant(), async (session) => {
        const page = await session.catalog.listProducts(input);

        // N+1 evitado: categorias e grupos lidos de uma vez (mapas).
        const categoryNames = await session.catalog.listCategories();
        const groupNames = await session.catalog.listKitchenGroups();
        const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));
        const groupMap = new Map(groupNames.map((g) => [g.id, g.name]));

        const balances = await session.stock.balances(page.data.map((p) => p.id));

        const data = page.data.map((p) =>
          serialize(
            p,
            {
              categoryName: p.categoryId ? (catMap.get(p.categoryId) ?? null) : null,
              kitchenGroupName: p.kitchenGroupId ? (groupMap.get(p.kitchenGroupId) ?? null) : null,
            },
            balances.get(p.id) ?? 0,
          ),
        );
        const result = { data, total: page.total };
        await deps.cache.set(key, result, { ttl: 120 });
        return result;
      });
    },

    async createProductUsecase(
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
      actorId: string,
    ) {
      if (input.price < 0) throw Errors.validationFailed({ field: "price" });
      if (input.costPrice !== undefined && input.costPrice < 0)
        throw Errors.validationFailed({ field: "costPrice" });
      if (input.lowStockThreshold !== undefined && input.lowStockThreshold < 0)
        throw Errors.validationFailed({ field: "lowStockThreshold" });

      return deps.uow.run(deps.tenant(), async (session) => {
        if (input.categoryId) {
          const cat = await session.catalog.findCategoryById(input.categoryId);
          if (!cat) throw Errors.validationFailed({ field: "categoryId" });
        }
        if (input.kitchenGroupId) {
          const grp = await session.catalog.findKitchenGroupById(input.kitchenGroupId);
          if (!grp) throw Errors.validationFailed({ field: "kitchenGroupId" });
        }

        const created = await session.catalog.saveProduct({
          categoryId: input.categoryId,
          kitchenGroupId: input.kitchenGroupId,
          name: input.name,
          description: input.description,
          price: input.price,
          variations: JSON.stringify(input.variations ?? []),
          ifoodEnabled: input.ifoodEnabled,
          ifoodSku: input.ifoodSku,
          featured: input.featured,
          costPrice: input.costPrice,
          lowStockThreshold: input.lowStockThreshold,
          trackStock: input.trackStock,
          unit: input.unit,
          active: input.active,
        });

        // Estoque inicial informado no cadastro vira um ajuste no ledger
        // (mesma transação — regra: escrita de domínio + audit juntos).
        // Com unit_cost = cost_price manual, vira o primeiro evento de
        // valoração da média móvel quando as compras forem habilitadas.
        if (input.trackStock && input.initialStock !== undefined && input.initialStock !== 0) {
          await session.stock.recordMovement({
            productId: created.id,
            quantityDelta: input.initialStock,
            type: "adjustment",
            unitCost: input.costPrice ?? 0,
            note: "Estoque inicial",
            actorId,
          });
        }
        await session.audit.record({
          actorId,
          action: "product_created",
          details: { productId: created.id, name: created.name },
        });

        await deps.cache.invalidatePrefix("products:");
        return serializeWithStock(session, created);
      });
    },

    async updateProductUsecase(
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
      actorId: string,
    ) {
      if (input.price !== undefined && input.price < 0)
        throw Errors.validationFailed({ field: "price" });
      if (input.costPrice !== undefined && input.costPrice < 0)
        throw Errors.validationFailed({ field: "costPrice" });
      if (input.lowStockThreshold !== undefined && input.lowStockThreshold < 0)
        throw Errors.validationFailed({ field: "lowStockThreshold" });

      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findProduct(id);
        if (!existing) throw Errors.notFound("Produto");
        if (input.categoryId) {
          const cat = await session.catalog.findCategoryById(input.categoryId);
          if (!cat) throw Errors.validationFailed({ field: "categoryId" });
        }
        if (input.kitchenGroupId) {
          const grp = await session.catalog.findKitchenGroupById(input.kitchenGroupId);
          if (!grp) throw Errors.validationFailed({ field: "kitchenGroupId" });
        }

        const updated = await session.catalog.saveProduct({
          id,
          categoryId: input.categoryId,
          kitchenGroupId: input.kitchenGroupId,
          name: input.name,
          description: input.description,
          price: input.price,
          variations: input.variations === undefined ? undefined : JSON.stringify(input.variations ?? []),
          ifoodEnabled: input.ifoodEnabled,
          ifoodSku: input.ifoodSku,
          featured: input.featured,
          costPrice: input.costPrice,
          lowStockThreshold: input.lowStockThreshold,
          trackStock: input.trackStock,
          unit: input.unit,
          active: input.active,
        });
        await session.audit.record({
          actorId,
          action: "product_updated",
          details: { productId: id, name: updated.name },
        });

        await deps.cache.invalidatePrefix("products:");
        return serializeWithStock(session, updated);
      });
    },

    async setProductActiveUsecase(id: string, active: boolean, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findProduct(id);
        if (!existing) throw Errors.notFound("Produto");
        const updated = await session.catalog.setProductActive(id, active);
        await session.audit.record({
          actorId,
          action: active ? "product_activated" : "product_deactivated",
          details: { productId: id, name: updated.name },
        });
        await deps.cache.invalidatePrefix("products:");
        return serializeWithStock(session, updated);
      });
    },

    // ---------- Foto (upload em disco, caminho gravado em product.image_path) ----------
    //
    // O `storage` (port FileStorage) é quem grava/apaga o arquivo; aqui
    // fica só o que é regra de produto: o nome vem do id (o
    // "minha-foto.png" enviado no multipart nunca vira caminho), o
    // `image_path` guarda SÓ o basename e o audit vai na mesma
    // transação do UPDATE.

    async saveProductImageUsecase(
      id: string,
      input: { buffer: Buffer; ext: string },
      actorId: string,
    ) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findProduct(id);
        if (!existing) throw Errors.notFound("Produto");

        const filename = `${id}.${input.ext}`;
        if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "image" });
        await deps.storage.put("product", filename, input.buffer);

        // Remove a foto antiga quando o produto trocou a extensão do arquivo
        const previous = storageFilename(existing.imagePath);
        if (previous && previous !== filename) await deps.storage.remove("product", previous);

        const updated = await session.catalog.saveProductImage(id, filename);
        await session.audit.record({
          actorId,
          action: "product_image_changed",
          details: { productId: id },
        });
        await deps.cache.invalidatePrefix("products:");
        return serializeWithStock(session, updated);
      });
    },

    async clearProductImageUsecase(id: string, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.catalog.findProduct(id);
        if (!existing) throw Errors.notFound("Produto");
        const previous = storageFilename(existing.imagePath);
        if (previous) await deps.storage.remove("product", previous);

        const updated = await session.catalog.clearProductImage(id);
        await session.audit.record({
          actorId,
          action: "product_image_removed",
          details: { productId: id },
        });
        await deps.cache.invalidatePrefix("products:");
        return serializeWithStock(session, updated);
      });
    },
  };
}

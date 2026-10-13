import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { categories, kitchenGroups, products, restaurantTables } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import { normalizeAccents } from "../../../domain/text.js";
import type {
  CatalogRepository,
  CategoryRecord,
  Id,
  KitchenGroupRecord,
  OrderingProductRecord,
  Page,
  PageQuery,
  ProductRecord,
  TableRecord,
} from "../../../application/ports/repositories.js";

/** Régua de preço do catálogo (idêntica ao use case antigo). */
function assertPriceNotNegative(price: number | undefined): void {
  if (price !== undefined && price < 0) throw Errors.validationFailed({ field: "price" });
}

// =====================================================================
// Catálogo
// =====================================================================

function toProductRecord(p: typeof products.$inferSelect): ProductRecord {
  return {
    id: p.id,
    categoryId: p.categoryId,
    kitchenGroupId: p.kitchenGroupId,
    name: p.name,
    description: p.description,
    price: p.price,
    variations: p.variations,
    featured: p.featured,
    costPrice: p.costPrice,
    lowStockThreshold: p.lowStockThreshold,
    trackStock: p.trackStock,
    unit: p.unit,
    active: p.active,
    imagePath: p.imagePath,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export class PostgresCatalogRepository implements CatalogRepository {
  constructor(private readonly tx: Tx) {}

  /**
   * Mesmos filtros/ordenação de `listProductsUsecase` (categoryId, active,
   * busca `unaccent ILIKE`, sort price_asc/price_desc/nome). O CACHE de lista
   * (`products:list:*`, TTL 120s) não é do repositório — fica no use case
   * migrado via port `TenantCache`.
   */
  async listProducts(
    query: PageQuery & { categoryId?: Id; active?: boolean; search?: string; sort?: string },
  ): Promise<Page<ProductRecord>> {
    const conditions: SQL[] = [];
    if (query.categoryId) conditions.push(eq(products.categoryId, query.categoryId));
    if (query.active !== undefined) conditions.push(eq(products.active, query.active));
    if (query.search) {
      const term = `%${normalizeAccents(query.search)}%`;
      conditions.push(sql`unaccent(${products.name}) ILIKE unaccent(${term})`);
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const orderBy =
      query.sort === "price_asc"
        ? asc(products.price)
        : query.sort === "price_desc"
          ? desc(products.price)
          : asc(products.name);

    const rows = await this.tx.query.products.findMany({
      where,
      orderBy,
      limit: query.limit,
      offset: query.offset,
    });
    const totalRow = await this.tx.select({ count: count() }).from(products).where(where);
    return { data: rows.map(toProductRecord), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  async findProduct(id: Id): Promise<ProductRecord | null> {
    const row = await this.tx.query.products.findFirst({ where: eq(products.id, id) });
    return row ? toProductRecord(row) : null;
  }

  /**
   * Create/update num método só. Os defaults de criação são os mesmos de
   * `createProductUsecase` (description "", active true, imagePath null; o
   * resto — variations/custo/estoque — cai nos defaults do schema, que o
   * use case antigo replicava literalmente). O estoque inicial
   * (`initialStock` → ledger) NÃO entra aqui: `ProductRecord` não tem o campo e
   * o ledger é `session.stock.recordMovement` chamado pelo use case.
   */
  async saveProduct(input: Partial<ProductRecord> & { id?: Id }): Promise<ProductRecord> {
    assertPriceNotNegative(input.price);

    if (input.id) {
      const [row] = await this.tx
        .update(products)
        .set({
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.kitchenGroupId !== undefined ? { kitchenGroupId: input.kitchenGroupId } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.variations !== undefined ? { variations: input.variations } : {}),
          ...(input.featured !== undefined ? { featured: input.featured } : {}),
          ...(input.costPrice !== undefined ? { costPrice: input.costPrice } : {}),
          ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
          ...(input.trackStock !== undefined ? { trackStock: input.trackStock } : {}),
          ...(input.unit !== undefined ? { unit: input.unit.trim() || "un" } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.imagePath !== undefined ? { imagePath: input.imagePath } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(products.id, input.id))
        .returning();
      if (!row) throw Errors.notFound("Produto");
      return toProductRecord(row);
    }

    if (input.name === undefined || input.price === undefined) {
      throw Errors.validationFailed({ field: "name" });
    }

    const [row] = await this.tx
      .insert(products)
      .values({
        categoryId: input.categoryId ?? null,
        kitchenGroupId: input.kitchenGroupId ?? null,
        name: input.name,
        description: input.description ?? "",
        price: input.price,
        variations: input.variations ?? "[]",
        featured: input.featured ?? false,
        costPrice: input.costPrice ?? 0,
        lowStockThreshold: input.lowStockThreshold ?? 0,
        trackStock: input.trackStock ?? false,
        unit: input.unit?.trim() || "un",
        active: input.active ?? true,
        imagePath: input.imagePath ?? null,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return toProductRecord(row);
  }

  async listCategories(): Promise<CategoryRecord[]> {
    const rows = await this.tx.query.categories.findMany({ orderBy: asc(categories.displayOrder) });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      displayOrder: c.displayOrder,
      active: c.active,
      createdAt: c.createdAt,
    }));
  }

  async listKitchenGroups(): Promise<KitchenGroupRecord[]> {
    const rows = await this.tx.query.kitchenGroups.findMany({ orderBy: asc(kitchenGroups.displayOrder) });
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      displayOrder: g.displayOrder,
      active: g.active,
      createdAt: g.createdAt,
    }));
  }

  // ---------- ADIÇÃO (Onda 2 — hub de pedidos: mesas e produto de lançamento) ----------

  async findTable(id: Id): Promise<TableRecord | null> {
    const row = await this.tx.query.restaurantTables.findFirst({ where: eq(restaurantTables.id, id) });
    return row ?? null;
  }

  /** Mesas em ordem de número — texto, como o `asc(t.number)` de `listTablesUsecase`. */
  async listTables(): Promise<TableRecord[]> {
    return this.tx.query.restaurantTables.findMany({ orderBy: (t, { asc: asc_ }) => asc_(t.number) });
  }

  async listTablesByIds(ids: Id[]): Promise<TableRecord[]> {
    if (ids.length === 0) return [];
    return this.tx.query.restaurantTables.findMany({ where: inArray(restaurantTables.id, ids) });
  }

  /**
   * Claim atômico: UPDATE condicional `status = 'free'` → `occupied`, como em
   * `openOrderUsecase`. Devolve `false` sem nenhuma leitura extra — decidir
   * 404/409 é do use case (`findTable` depois), para não reintroduzir a corrida.
   */
  async tryClaimTable(tableId: Id): Promise<boolean> {
    const claimed = await this.tx
      .update(restaurantTables)
      .set({ status: "occupied" })
      .where(and(eq(restaurantTables.id, tableId), eq(restaurantTables.status, "free")))
      .returning({ id: restaurantTables.id });
    return claimed.length > 0;
  }

  /** Libera a mesa no fechamento/cancelamento (UPDATE incondicional, como hoje). */
  async releaseTable(tableId: Id): Promise<void> {
    await this.tx.update(restaurantTables).set({ status: "free" }).where(eq(restaurantTables.id, tableId));
  }

  /**
   * Produto do ponto de vista do LANÇAMENTO: snapshot de preço/custo,
   * rastreamento/threshold e estação de produção — é o que `addItems` e o
   * movimento manual de estoque leem (`findProduct` não traz estes campos).
   */
  async findProductForOrdering(id: Id): Promise<OrderingProductRecord | null> {
    const p = await this.tx.query.products.findFirst({ where: eq(products.id, id) });
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      price: p.price,
      costPrice: p.costPrice,
      active: p.active,
      imagePath: p.imagePath,
      kitchenGroupId: p.kitchenGroupId,
      trackStock: p.trackStock,
      lowStockThreshold: p.lowStockThreshold,
    };
  }

  // ---------- ADIÇÃO (Onda 3A — catálogo: categoria, grupo, vitrine) ----------

  async findCategoryById(id: Id): Promise<CategoryRecord | null> {
    const row = await this.tx.query.categories.findFirst({ where: eq(categories.id, id) });
    return row
      ? {
          id: row.id,
          name: row.name,
          displayOrder: row.displayOrder,
          active: row.active,
          createdAt: row.createdAt,
        }
      : null;
  }

  async createCategory(input: { name: string; displayOrder?: number }): Promise<CategoryRecord> {
    const [row] = await this.tx
      .insert(categories)
      .values({ name: input.name, displayOrder: input.displayOrder ?? 0 })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return {
      id: row.id,
      name: row.name,
      displayOrder: row.displayOrder,
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  async updateCategory(
    id: Id,
    input: { name?: string; displayOrder?: number; active?: boolean },
  ): Promise<CategoryRecord> {
    const [row] = await this.tx
      .update(categories)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(categories.id, id))
      .returning();
    if (!row) throw Errors.notFound("Categoria");
    return {
      id: row.id,
      name: row.name,
      displayOrder: row.displayOrder,
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  /** Exclusão real; produtos vinculados ficam com `category_id = null` (§7.5). */
  async deleteCategory(id: Id): Promise<void> {
    await this.tx.update(products).set({ categoryId: null }).where(eq(products.categoryId, id));
    await this.tx.delete(categories).where(eq(categories.id, id));
  }

  async findKitchenGroupById(id: Id): Promise<KitchenGroupRecord | null> {
    const row = await this.tx.query.kitchenGroups.findFirst({ where: eq(kitchenGroups.id, id) });
    return row
      ? {
          id: row.id,
          name: row.name,
          displayOrder: row.displayOrder,
          active: row.active,
          createdAt: row.createdAt,
        }
      : null;
  }

  async createKitchenGroup(input: { name: string; displayOrder?: number }): Promise<KitchenGroupRecord> {
    const [row] = await this.tx
      .insert(kitchenGroups)
      .values({ name: input.name, displayOrder: input.displayOrder ?? 0 })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return {
      id: row.id,
      name: row.name,
      displayOrder: row.displayOrder,
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  async updateKitchenGroup(
    id: Id,
    input: { name?: string; displayOrder?: number; active?: boolean },
  ): Promise<KitchenGroupRecord> {
    const [row] = await this.tx
      .update(kitchenGroups)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(kitchenGroups.id, id))
      .returning();
    if (!row) throw Errors.notFound("Grupo de produção");
    return {
      id: row.id,
      name: row.name,
      displayOrder: row.displayOrder,
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  /** Exclusão real; produtos vinculados ficam com `kitchen_group_id = null`. */
  async deleteKitchenGroup(id: Id): Promise<void> {
    await this.tx.update(products).set({ kitchenGroupId: null }).where(eq(products.kitchenGroupId, id));
    await this.tx.delete(kitchenGroups).where(eq(kitchenGroups.id, id));
  }

  async setProductActive(id: Id, active: boolean): Promise<ProductRecord> {
    const [row] = await this.tx
      .update(products)
      .set({ active })
      .where(eq(products.id, id))
      .returning();
    if (!row) throw Errors.notFound("Produto");
    return toProductRecord(row);
  }

  async saveProductImage(id: Id, filename: string): Promise<ProductRecord> {
    const [row] = await this.tx
      .update(products)
      .set({ imagePath: filename })
      .where(eq(products.id, id))
      .returning();
    if (!row) throw Errors.notFound("Produto");
    return toProductRecord(row);
  }

  async clearProductImage(id: Id): Promise<ProductRecord> {
    const [row] = await this.tx
      .update(products)
      .set({ imagePath: null })
      .where(eq(products.id, id))
      .returning();
    if (!row) throw Errors.notFound("Produto");
    return toProductRecord(row);
  }

  async listActiveProducts(): Promise<ProductRecord[]> {
    const rows = await this.tx.query.products.findMany({
      where: eq(products.active, true),
      orderBy: asc(products.name),
    });
    return rows.map(toProductRecord);
  }

  async listActiveCategories(): Promise<Array<{ id: Id; name: string }>> {
    const rows = await this.tx.query.categories.findMany({
      where: eq(categories.active, true),
      orderBy: asc(categories.displayOrder),
    });
    return rows.map((c) => ({ id: c.id, name: c.name }));
  }

  /** ADIÇÃO (Onda 3 — self-service): lote por ids (validação de variações do checkout). */
  async findProductsByIds(ids: Id[]): Promise<ProductRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.query.products.findMany({ where: inArray(products.id, ids) });
    return rows.map(toProductRecord);
  }

  /**
   * ADIÇÃO (Onda financeiro — compras): espelha o custo médio móvel corrente em
   * `product.cost_price` (`createPurchaseUsecase`). Não toca `updated_at` — o
   * original também não; a coluna é display.
   */
  async setCostPrice(productId: Id, costPrice: number): Promise<void> {
    await this.tx.update(products).set({ costPrice }).where(eq(products.id, productId));
  }
}


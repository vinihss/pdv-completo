/**
 * Implementações Postgres dos repositórios — adapters da FASE 0.
 *
 * Cada classe recebe o `tx` DA TRANSAÇÃO corrente (`TenantUnitOfWork.run`) e
 * traduz a port para Drizzle + `schema.ts`, replicando a semântica dos use
 * cases atuais (colunas, defaults, filtros, ordenação, paginação).
 *
 * O que ESTE arquivo NÃO faz (e não deve passar a fazer sem decisão explícita):
 *   - audit/outbox: quem chama é o use case, via `session.audit`/`session.outbox`
 *     (mesma transação, mesma atomicidade da escrita de domínio);
 *   - cache (`tenantCache`) e storage de arquivos: são efeitos do use case,
 *     fora da janela transacional do port;
 *   - validações de domínio além das óbvias (ex.: preço negativo): a régua
 *     completa continua nos use cases até a migração de cada um.
 *
 * Métodos ainda não implementados lançam `Error("not_implemented: ...")` com o
 * TODO da onda responsável — nenhum use case os consome nesta fase.
 */
import { and, asc, count, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "./client.js";
import {
  alerts,
  auditLog,
  cashDrawers,
  cashDrawerMovements,
  categories,
  customers,
  deliveries,
  kitchenGroups,
  orderItems,
  orderPayments,
  orders,
  outboxEvents,
  payments,
  products,
  purchases,
  restaurantTables,
  stockMovements,
  users,
} from "./schema.js";
import { isUniqueViolationOn } from "./errors.js";
import type {
  AlertRecord,
  AlertRepository,
  AuditWriter,
  CashFlowRepository,
  CatalogRepository,
  CategoryRecord,
  CustomerRecord,
  CustomerRepository,
  DeliveryRecord,
  DeliveryRepository,
  DeliveryStatus,
  Id,
  KitchenGroupRecord,
  MovingAverageRecord,
  OrderItemRow,
  OrderItemWithProduct,
  OrderPaymentLineRow,
  OrderChannel,
  OrderRecord,
  OrderRepository,
  OrderRow,
  OrderingProductRecord,
  Page,
  PageQuery,
  PaymentRecord,
  PaymentRepository,
  ProductRecord,
  PurchaseRecord,
  PurchaseRepository,
  StockMovementViewRecord,
  StockRepository,
  TableRecord,
  TrackedStockProductRecord,
  UserRecord,
  UserRepository,
  OutboxWriter,
} from "../../application/ports/repositories.js";
import { Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { round2 } from "../../domain/money.js";
import { normalizeAccents } from "../../domain/text.js";
// ADIÇÃO (Onda 2): o recorte de audiência do sino usa o MESMO token `user:<id>`
// que o use case/publicação usa — a régua mora no adapter (port não conhece SQL),
// mas o vocabulário continua sendo o da application.
import { alertUserToken } from "../../application/alert/alert.usecases.js";
// ADIÇÃO (Onda 2): replay puro do ledger para a média móvel — mesma fórmula
// de `computeMovingAverageTx`, sem reimplementar a valoração aqui.
import { replayMovingAverage, type MovingAverage } from "../../application/stock/stock.usecases.js";

function notImplemented(what: string): never {
  throw new Error(`not_implemented: ${what}`);
}

function assertPriceNotNegative(price: number | undefined): void {
  if (price !== undefined && price < 0) throw Errors.validationFailed({ field: "price" });
}

/** Colunas `text` que guardam JSON: aceitam objeto (serializado aqui) ou a string já pronta. */
function toJsonText(value: unknown, fallback = "{}"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
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
    ifoodEnabled: p.ifoodEnabled,
    ifoodSku: p.ifoodSku,
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
   * resto — variations/ifood/custo/estoque — cai nos defaults do schema, que o
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
          ...(input.ifoodEnabled !== undefined ? { ifoodEnabled: input.ifoodEnabled } : {}),
          ...(input.ifoodSku !== undefined ? { ifoodSku: input.ifoodSku } : {}),
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
        ifoodEnabled: input.ifoodEnabled ?? false,
        ifoodSku: input.ifoodSku ?? null,
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
}

// =====================================================================
// Clientes
// =====================================================================

function toCustomerRecord(c: typeof customers.$inferSelect): CustomerRecord {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    cpf: c.cpf,
    notes: c.notes,
    photoPath: c.photoPath,
    active: c.active,
    createdAt: c.createdAt,
  };
}

// Busca da manutenção (mesma da `listCustomersUsecase`): nome/telefone/email,
// ignorando acentos e caixa. O termo já vem normalizado do use case.
function customerSearchCondition(term: string): SQL {
  const t = `%${term}%`;
  return sql`(
    unaccent(${customers.name}) ILIKE unaccent(${t})
    OR ${customers.phone} ILIKE ${t}
    OR unaccent(${customers.email}) ILIKE unaccent(${t})
  )`;
}

export class PostgresCustomerRepository implements CustomerRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<CustomerRecord | null> {
    const row = await this.tx.query.customers.findFirst({ where: eq(customers.id, id) });
    return row ? toCustomerRecord(row) : null;
  }

  /** Phone crudo como veio — normalizar dígitos é do use case (como hoje). */
  async findByPhone(phone: string): Promise<CustomerRecord | null> {
    const row = await this.tx.query.customers.findFirst({ where: eq(customers.phone, phone) });
    return row ? toCustomerRecord(row) : null;
  }

  async list(query: PageQuery & { search?: string }): Promise<Page<CustomerRecord>> {
    const conditions: SQL[] = [];
    if (query.search?.trim()) conditions.push(customerSearchCondition(normalizeAccents(query.search.trim())));
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.tx.query.customers.findMany({
      where,
      orderBy: (c, { asc: asc_ }) => asc_(c.name),
      limit: query.limit,
      offset: query.offset,
    });
    const totalRow = await this.tx.select({ count: count() }).from(customers).where(where);
    return { data: rows.map(toCustomerRecord), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  /**
   * Create/update. Normalizações (phone dígitos, email lowercase, CPF crudo)
   * e unicidade (email/CPF com 400) continuam no use case migrado — aqui vale
   * o que o banco aceita + as unique indexes `uq_customer_email`/`uq_customer_cpf`.
   */
  async save(input: Partial<CustomerRecord> & Pick<CustomerRecord, "name">): Promise<CustomerRecord> {
    if (input.id) {
      const [row] = await this.tx
        .update(customers)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.cpf !== undefined ? { cpf: input.cpf } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.photoPath !== undefined ? { photoPath: input.photoPath } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        })
        .where(eq(customers.id, input.id))
        .returning();
      if (!row) throw Errors.notFound("Cliente");
      return toCustomerRecord(row);
    }

    const [row] = await this.tx
      .insert(customers)
      .values({
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        cpf: input.cpf ?? null,
        notes: input.notes ?? null,
        photoPath: input.photoPath ?? null,
        active: input.active ?? true,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return toCustomerRecord(row);
  }

  /** Soft-delete: histórico de pedidos impede remoção física (como o sistema faz hoje). */
  async delete(id: Id): Promise<void> {
    const [row] = await this.tx
      .update(customers)
      .set({ active: false })
      .where(eq(customers.id, id))
      .returning({ id: customers.id });
    if (!row) throw Errors.notFound("Cliente");
  }

  /** ADIÇÃO (Onda 2): lote por ids — hidratação da listagem de comandas sem N+1. */
  async findByIds(ids: Id[]): Promise<CustomerRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.query.customers.findMany({ where: inArray(customers.id, ids) });
    return rows.map(toCustomerRecord);
  }
}

// =====================================================================
// Usuários
// =====================================================================

function toUserRecord(u: typeof users.$inferSelect): UserRecord {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    pinHash: u.pinHash,
    active: u.active,
    phone: u.phone,
    email: u.email,
    photoPath: u.photoPath,
    createdAt: u.createdAt,
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<UserRecord | null> {
    const row = await this.tx.query.users.findFirst({ where: eq(users.id, id) });
    return row ? toUserRecord(row) : null;
  }

  /** Id, telefone ou email (case-insensitive). PIN/lockout são do use case de login. */
  async findByLogin(login: string): Promise<UserRecord | null> {
    let row = await this.tx.query.users.findFirst({ where: eq(users.id, login) });
    if (!row) row = await this.tx.query.users.findFirst({ where: eq(users.phone, login) });
    if (!row) {
      row = await this.tx.query.users.findFirst({
        where: sql`lower(${users.email}) = lower(${login})`,
      });
    }
    return row ? toUserRecord(row) : null;
  }

  async listActive(): Promise<Array<Pick<UserRecord, "id" | "name" | "role">>> {
    const rows = await this.tx.query.users.findMany({
      where: eq(users.active, true),
      orderBy: (u, { asc: asc_ }) => asc_(u.name),
    });
    return rows.map((u) => ({ id: u.id, name: u.name, role: u.role }));
  }

  /**
   * Create/update. O PIN NÃO é gerado aqui: o use case hasheia com argon2 e
   * passa em `pinHash` (obrigatório na criação — coluna NOT NULL).
   * Quando `pinHash` muda, zera `failedAttempts`/`lockedUntil`, exatamente
   * como `updateUserUsecase` faz hoje. Unicidade de email continua no use
   * case (não há unique index em `user.email`).
   */
  async save(input: Partial<UserRecord> & Pick<UserRecord, "name" | "role">): Promise<UserRecord> {
    if (input.id) {
      const existing = await this.tx.query.users.findFirst({ where: eq(users.id, input.id) });
      if (!existing) throw Errors.notFound("Usuário");
      const pinChanged = input.pinHash !== undefined && input.pinHash !== existing.pinHash;
      const [row] = await this.tx
        .update(users)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.photoPath !== undefined ? { photoPath: input.photoPath } : {}),
          ...(pinChanged ? { pinHash: input.pinHash, failedAttempts: 0, lockedUntil: null } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, input.id))
        .returning();
      if (!row) throw Errors.notFound("Usuário");
      return toUserRecord(row);
    }

    if (!input.pinHash) throw Errors.validationFailed({ field: "pinHash" });
    const [row] = await this.tx
      .insert(users)
      .values({
        name: input.name,
        role: input.role,
        pinHash: input.pinHash,
        active: input.active ?? true,
        phone: input.phone ?? null,
        email: input.email ?? null,
        photoPath: input.photoPath ?? null,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return toUserRecord(row);
  }
}

// =====================================================================
// Comandas
// =====================================================================

/**
 * Total da comanda = soma de `unit_price × quantity` do SNAPSHOT, excluindo
 * itens `cancelled`, + taxa de entrega (mesmíssimo cálculo de
 * `computeOrderTotal`). `deliveryFee` entra aqui porque não é item.
 */
async function orderTotals(
  tx: Tx,
  rows: Array<{ id: Id; deliveryFee: number | null }>,
): Promise<Map<Id, number>> {
  const totals = new Map<Id, number>();
  if (rows.length === 0) return totals;
  const agg = await tx
    .select({
      orderId: orderItems.orderId,
      total: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)`,
    })
    .from(orderItems)
    .where(
      and(
        inArray(
          orderItems.orderId,
          rows.map((r) => r.id),
        ),
        sql`${orderItems.status} <> 'cancelled'`,
      ),
    )
    .groupBy(orderItems.orderId);
  const byOrder = new Map(agg.map((r) => [r.orderId, Number(r.total ?? 0)]));
  for (const row of rows) {
    totals.set(row.id, round2((byOrder.get(row.id) ?? 0) + (row.deliveryFee ?? 0)));
  }
  return totals;
}

// ---------- ADIÇÃO (Onda 2): mappers linha-a-linha (fiéis ao schema) ----------

function toOrderRow(r: typeof orders.$inferSelect): OrderRow {
  return {
    id: r.id,
    tableId: r.tableId,
    customerId: r.customerId,
    tabLabel: r.tabLabel,
    waiterId: r.waiterId,
    status: r.status,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    paymentMethod: r.paymentMethod,
    paymentConfirmedAt: r.paymentConfirmedAt,
    paymentConfirmedBy: r.paymentConfirmedBy,
    channel: r.channel as OrderChannel, // legado: linhas antigas podem trazer 'whatsapp'
    externalRef: r.externalRef,
    deliveryFee: r.deliveryFee,
    cancelReason: r.cancelReason,
    notes: r.notes,
    ifoodPayments: r.ifoodPayments,
  };
}

function toOrderItemRow(r: typeof orderItems.$inferSelect): OrderItemRow {
  return {
    id: r.id,
    orderId: r.orderId,
    productId: r.productId,
    quantity: r.quantity,
    unitPrice: r.unitPrice,
    costPrice: r.costPrice,
    selectedVariations: r.selectedVariations,
    notes: r.notes,
    status: r.status,
    version: r.version,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toPaymentLineRow(r: typeof orderPayments.$inferSelect): OrderPaymentLineRow {
  return {
    id: r.id,
    orderId: r.orderId,
    method: r.method,
    amount: r.amount,
    received: r.received,
    change: r.change,
    confirmed: r.confirmed,
    confirmedAt: r.confirmedAt,
    confirmedBy: r.confirmedBy,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

export class PostgresOrderRepository implements OrderRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<OrderRecord | null> {
    const row = await this.tx.query.orders.findFirst({ where: eq(orders.id, id) });
    if (!row) return null;
    const totals = await orderTotals(this.tx, [{ id: row.id, deliveryFee: row.deliveryFee }]);
    return {
      id: row.id,
      status: row.status,
      tableId: row.tableId,
      total: totals.get(row.id) ?? 0,
    };
  }

  /** Comanda em aberto da mesa — mais recente primeiro (deve haver uma só). */
  async findOpenForTable(tableId: Id): Promise<OrderRecord | null> {
    const row = await this.tx.query.orders.findFirst({
      where: and(eq(orders.tableId, tableId), eq(orders.status, "open")),
      orderBy: desc(orders.openedAt),
    });
    if (!row) return null;
    const totals = await orderTotals(this.tx, [{ id: row.id, deliveryFee: row.deliveryFee }]);
    return { id: row.id, status: row.status, tableId: row.tableId, total: totals.get(row.id) ?? 0 };
  }

  /** Comandas abertas, mais recentes primeiro (mesma régua de `listOrdersUsecase` com status=open). */
  async listOpen(query: PageQuery): Promise<Page<OrderRecord>> {
    const where = eq(orders.status, "open");
    const rows = await this.tx.query.orders.findMany({
      where,
      orderBy: desc(orders.openedAt),
      limit: query.limit,
      offset: query.offset,
    });
    const totals = await orderTotals(
      this.tx,
      rows.map((r) => ({ id: r.id, deliveryFee: r.deliveryFee })),
    );
    const totalRow = await this.tx.select({ count: count() }).from(orders).where(where);
    return {
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        tableId: r.tableId,
        total: totals.get(r.id) ?? 0,
      })),
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  // TODO(onda de order.usecases): `create` precisa do `waiterId` (coluna NOT
  // NULL) e da checagem de identificação (mesa/cliente/tabLabel) + claim
  // atômico da mesa + alerta/outbox — o input do port não carrega o ator.
  // Decidir na migração se o port ganha `waiterId`/`tabLabel` ou se o ator vem
  // do `TenantSession`; até lá, lançar erro é melhor que gravar errado.
  async create(_input: { tableId?: Id | null; customerId?: Id | null; channel: string }): Promise<OrderRecord> {
    return notImplemented("OrderRepository.create — precisa de waiterId/identificação (ver TODO no código)");
  }

  // TODO(onda de order.usecases): fechar/cancelar comanda tem invariantas de
  // pagamento, ledger (refund dos itens), caixa e eventos — replicar de
  // `closeOrderUsecase`/`cancelOrderUsecase` de uma vez. `expectedVersion` nem
  // tem coluna em `order` hoje (o lock otimista é de `order_item`).
  async transition(_id: Id, _status: OrderRecord["status"], _expectedVersion?: number): Promise<OrderRecord> {
    return notImplemented("OrderRepository.transition — invariantas de pagamento/ledger (ver TODO no código)");
  }

  // TODO(onda de order.usecases): não existe delete físico de comanda no
  // sistema atual (o cancelamento é a via de saída) — definir semântica antes.
  async delete(_id: Id): Promise<void> {
    return notImplemented("OrderRepository.delete — semântica a definir (o sistema cancela, não apaga)");
  }

  // ---------- ADIÇÃO (Onda 2 — hub de pedidos) ----------

  async findRow(id: Id): Promise<OrderRow | null> {
    const row = await this.tx.query.orders.findFirst({ where: eq(orders.id, id) });
    return row ? toOrderRow(row) : null;
  }

  /** Mesma régua de `listOrdersUsecase`: `openedAt DESC` + contagem em 1 query extra. */
  async listRows(query: { status?: "open" | "closed" | "cancelled"; limit: number; offset: number }): Promise<Page<OrderRow>> {
    const where = query.status ? eq(orders.status, query.status) : undefined;
    const rows = await this.tx.query.orders.findMany({
      where,
      orderBy: desc(orders.openedAt),
      limit: query.limit,
      offset: query.offset,
    });
    const totalRow = await this.tx.select({ count: count() }).from(orders).where(where);
    return { data: rows.map(toOrderRow), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  /**
   * INSERT da comanda (`POST /orders`). Identificação (mesa/cliente/tabLabel)
   * é conferida pelo CHECK `chk_order_identification_required`; o claim da mesa
   * e o alerta ficam no use case.
   */
  async open(input: {
    waiterId: Id;
    tableId?: Id | null;
    customerId?: Id | null;
    tabLabel?: Id | null;
    channel?: "balcao" | "web" | "ifood";
    deliveryFee?: number | null;
    externalRef?: string | null;
    notes?: string | null;
  }): Promise<OrderRow> {
    const [row] = await this.tx
      .insert(orders)
      .values({
        waiterId: input.waiterId,
        tableId: input.tableId ?? null,
        customerId: input.customerId ?? null,
        tabLabel: input.tabLabel ?? null,
        channel: input.channel ?? "balcao",
        deliveryFee: input.deliveryFee ?? null,
        externalRef: input.externalRef ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "waiterId" });
    return toOrderRow(row);
  }

  async markClosed(id: Id): Promise<OrderRow> {
    const [row] = await this.tx
      .update(orders)
      .set({ status: "closed", closedAt: new Date().toISOString() })
      .where(eq(orders.id, id))
      .returning();
    if (!row) throw Errors.notFound("Comanda");
    return toOrderRow(row);
  }

  async markCancelled(id: Id, reason: string): Promise<OrderRow> {
    const [row] = await this.tx
      .update(orders)
      .set({ status: "cancelled", closedAt: new Date().toISOString(), cancelReason: reason })
      .where(eq(orders.id, id))
      .returning();
    if (!row) throw Errors.notFound("Comanda");
    return toOrderRow(row);
  }

  async listStatuses(ids: Id[]): Promise<Array<{ id: Id; status: string }>> {
    if (ids.length === 0) return [];
    const rows = await this.tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(inArray(orders.id, ids));
    return rows.map((r) => ({ id: r.id, status: r.status }));
  }

  // -- itens --

  /** Itens crus (sem join de produto) — o que a máquina de stage/lote consome. */
  async listItemRows(orderId: Id): Promise<OrderItemRow[]> {
    const rows = await this.tx.query.orderItems.findMany({ where: eq(orderItems.orderId, orderId) });
    return rows.map(toOrderItemRow);
  }

  async listItemsWithProduct(orderId: Id): Promise<OrderItemWithProduct[]> {
    const rows = await this.tx
      .select({
        item: orderItems,
        productName: products.name,
        productImagePath: products.imagePath,
        productKitchenGroupId: products.kitchenGroupId,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(eq(orderItems.orderId, orderId));
    return rows.map(({ item, productName, productImagePath, productKitchenGroupId }) => ({
      ...toOrderItemRow(item),
      productName,
      productImagePath,
      productKitchenGroupId,
    }));
  }

  async listItemsWithProductForOrders(ids: Id[]): Promise<OrderItemWithProduct[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx
      .select({
        item: orderItems,
        productName: products.name,
        productImagePath: products.imagePath,
        productKitchenGroupId: products.kitchenGroupId,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(inArray(orderItems.orderId, ids));
    return rows.map(({ item, productName, productImagePath, productKitchenGroupId }) => ({
      ...toOrderItemRow(item),
      productName,
      productImagePath,
      productKitchenGroupId,
    }));
  }

  async findItem(itemId: Id): Promise<OrderItemRow | null> {
    const row = await this.tx.query.orderItems.findFirst({ where: eq(orderItems.id, itemId) });
    return row ? toOrderItemRow(row) : null;
  }

  async insertItem(input: {
    orderId: Id;
    productId: Id;
    quantity: number;
    unitPrice: number;
    costPrice: number;
    selectedVariations: string;
    notes?: string | null;
    createdBy: Id;
    status: "ordered" | "ready" | "delivered" | "cancelled";
  }): Promise<OrderItemRow> {
    const [row] = await this.tx
      .insert(orderItems)
      .values({
        orderId: input.orderId,
        productId: input.productId,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        costPrice: input.costPrice,
        selectedVariations: input.selectedVariations,
        notes: input.notes ?? null,
        createdBy: input.createdBy,
        status: input.status,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "productId" });
    return toOrderItemRow(row);
  }

  /**
   * Lock otimista: o UPDATE só casa quando a `version` esperada ainda vale
   * (mesma condição de `updateItemStatusUsecase`). `null` = conflito — o use
   * case relê a linha e responde `concurrency_conflict` com a versão corrente.
   */
  async transitionItemStatus(
    itemId: Id,
    status: "ready" | "delivered",
    expectedVersion: number,
  ): Promise<OrderItemRow | null> {
    const [row] = await this.tx
      .update(orderItems)
      .set({ status, version: sql`${orderItems.version} + 1`, updatedAt: new Date().toISOString() })
      .where(and(eq(orderItems.id, itemId), eq(orderItems.version, expectedVersion)))
      .returning();
    return row ? toOrderItemRow(row) : null;
  }

  async deleteItem(itemId: Id): Promise<void> {
    await this.tx.delete(orderItems).where(eq(orderItems.id, itemId));
  }

  async cancelActiveItems(orderId: Id): Promise<void> {
    await this.tx
      .update(orderItems)
      .set({ status: "cancelled" })
      .where(and(eq(orderItems.orderId, orderId), notInArray(orderItems.status, ["delivered", "cancelled"])));
  }

  // -- linhas de pagamento (`order_payment` — pagamento fracionado) --

  async listPaymentLines(orderId: Id): Promise<OrderPaymentLineRow[]> {
    const rows = await this.tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    return rows.map(toPaymentLineRow);
  }

  async listPaymentLinesForOrders(ids: Id[]): Promise<OrderPaymentLineRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.select().from(orderPayments).where(inArray(orderPayments.orderId, ids));
    return rows.map(toPaymentLineRow);
  }

  async findPaymentLine(id: Id): Promise<OrderPaymentLineRow | null> {
    const row = await this.tx.query.orderPayments.findFirst({ where: eq(orderPayments.id, id) });
    return row ? toPaymentLineRow(row) : null;
  }

  async insertPaymentLine(input: {
    orderId: Id;
    method: "cash" | "card" | "pix" | "other";
    amount: number;
    received: number | null;
    change: number | null;
    confirmed: boolean;
    confirmedAt: string | null;
    confirmedBy: Id | null;
    createdBy: Id;
  }): Promise<OrderPaymentLineRow> {
    const [row] = await this.tx
      .insert(orderPayments)
      .values({
        orderId: input.orderId,
        method: input.method,
        amount: input.amount,
        received: input.received,
        change: input.change,
        confirmed: input.confirmed,
        confirmedAt: input.confirmedAt,
        confirmedBy: input.confirmedBy,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "orderId" });
    return toPaymentLineRow(row);
  }

  async updatePaymentLineReceived(
    id: Id,
    input: { received: number | null; change: number | null },
  ): Promise<OrderPaymentLineRow> {
    const [row] = await this.tx
      .update(orderPayments)
      .set({ received: input.received, change: input.change })
      .where(eq(orderPayments.id, id))
      .returning();
    if (!row) throw Errors.notFound("Pagamento");
    return toPaymentLineRow(row);
  }

  async confirmPaymentLine(
    id: Id,
    input: { confirmedAt: string; confirmedBy: Id },
  ): Promise<OrderPaymentLineRow> {
    const [row] = await this.tx
      .update(orderPayments)
      .set({ confirmed: true, confirmedAt: input.confirmedAt, confirmedBy: input.confirmedBy })
      .where(eq(orderPayments.id, id))
      .returning();
    if (!row) throw Errors.notFound("Pagamento");
    return toPaymentLineRow(row);
  }

  async deletePaymentLine(id: Id): Promise<void> {
    await this.tx.delete(orderPayments).where(eq(orderPayments.id, id));
  }

  async deletePaymentLines(ids: Id[]): Promise<void> {
    if (ids.length === 0) return;
    await this.tx.delete(orderPayments).where(inArray(orderPayments.id, ids));
  }

  /**
   * Denormalizado de exibição em `order`. Só os campos presentes no patch são
   * escritos: a confirmação de UMA linha (confirmOrderPayment) muda só o
   * carimbo, sem regravar `payment_method`.
   */
  async updatePaymentSummary(
    id: Id,
    patch: { paymentMethod?: string | null; paymentConfirmedAt: string | null; paymentConfirmedBy: Id | null },
  ): Promise<void> {
    await this.tx
      .update(orders)
      .set({
        ...(patch.paymentMethod !== undefined ? { paymentMethod: patch.paymentMethod as "cash" | "card" | "pix" | "other" } : {}),
        paymentConfirmedAt: patch.paymentConfirmedAt,
        paymentConfirmedBy: patch.paymentConfirmedBy,
      })
      .where(eq(orders.id, id));
  }
}

// =====================================================================
// Estoque (ledger)
// =====================================================================

export class PostgresStockRepository implements StockRepository {
  constructor(private readonly tx: Tx) {}

  /** Saldo = soma de `quantity_delta` (idêntico a `stockBalance`). */
  async balance(productId: Id): Promise<number> {
    const rows = await this.tx
      .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
      .from(stockMovements)
      .where(eq(stockMovements.productId, productId));
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Espelha `applyStockMovementTx`: valida delta ≠ 0, insere no ledger e devolve
   * o saldo pós-movimento. O evento `stock.movement` (room `inventory`) NÃO é
   * emitido aqui — o use case migrado chama `session.outbox.enqueue` na mesma
   * transação (o adapter não tem acesso ao session).
   *
   * ADIÇÃO (Onda 2): `orderId`/`purchaseItemId` — colunas reais que os refunds
   * por comanda/item gravam; sem elas o estorno ficaria órfão no ledger.
   */
  async recordMovement(input: {
    productId: Id;
    quantityDelta: number;
    type: "sale" | "refund" | "purchase" | "adjustment";
    unitCost?: number;
    purchaseItemId?: Id | null;
    orderId?: Id | null;
    orderItemId?: Id | null;
    note?: string | null;
    actorId?: Id;
  }): Promise<number> {
    if (input.quantityDelta === 0) {
      throw Errors.validationFailed({ field: "quantity", reason: "não pode ser zero" });
    }
    await this.tx.insert(stockMovements).values({
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      unitCost: input.unitCost ?? null,
      purchaseItemId: input.purchaseItemId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      note: input.note ?? null,
      createdBy: input.actorId ?? SYSTEM_USER_ID,
    });
    return this.balance(input.productId);
  }

  // TODO: o ledger de hoje não tem "reserva" — a baixa acontece como
  // movimento `sale` por item em `addItemsUsecase` (e o estorno é `refund`).
  // Se reserve/release forem reais, definir semântica (hold? linha auxiliar?)
  // na onda que migrar order.usecases; inventar aqui seria mentir o port.
  async reserveForOrder(_orderId: Id): Promise<void> {
    return notImplemented("StockRepository.reserveForOrder — conceito não existe no ledger atual");
  }

  async releaseForOrder(_orderId: Id): Promise<void> {
    return notImplemented("StockRepository.releaseForOrder — conceito não existe no ledger atual");
  }

  // ---------- ADIÇÃO (Onda 2 — hub de pedidos) ----------

  /** Saldos de vários produtos em uma query agrupada (mesmo SQL de `stockBalances`). */
  async balances(productIds: Id[]): Promise<Map<Id, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.tx
      .select({ productId: stockMovements.productId, total: sql<number>`sum(${stockMovements.quantityDelta})` })
      .from(stockMovements)
      .where(inArray(stockMovements.productId, productIds))
      .groupBy(stockMovements.productId);
    return new Map(rows.map((r) => [r.productId, r.total ?? 0]));
  }

  /** Replay do ledger de 1 produto — mesma query/ordenação de `computeMovingAverageTx`. */
  async movingAverage(productId: Id, fallbackCost: number): Promise<MovingAverageRecord> {
    const rows = await this.tx
      .select({ quantityDelta: stockMovements.quantityDelta, unitCost: stockMovements.unitCost })
      .from(stockMovements)
      .where(eq(stockMovements.productId, productId))
      .orderBy(stockMovements.createdAt, stockMovements.seq);
    return replayMovingAverage(rows, fallbackCost);
  }

  /** Custo médio de vários produtos — replay em 1 query, como `averageCosts`. */
  async averageCosts(productIds: Id[]): Promise<Map<Id, MovingAverageRecord>> {
    const res = new Map<Id, MovingAverage>();
    if (productIds.length === 0) return res;
    const rows = await this.tx
      .select({
        productId: stockMovements.productId,
        quantityDelta: stockMovements.quantityDelta,
        unitCost: stockMovements.unitCost,
      })
      .from(stockMovements)
      .where(inArray(stockMovements.productId, productIds))
      .orderBy(stockMovements.createdAt, stockMovements.seq);
    const groups = new Map<Id, { quantityDelta: number; unitCost: number | null }[]>();
    for (const r of rows) {
      let list = groups.get(r.productId);
      if (!list) {
        list = [];
        groups.set(r.productId, list);
      }
      list.push({ quantityDelta: r.quantityDelta, unitCost: r.unitCost });
    }
    for (const [productId, group] of groups) res.set(productId, replayMovingAverage(group, 0));
    return res;
  }

  /**
   * Linhas de `GET /stock` — mesmos filtros de `listStockUsecase` (trackStock,
   * busca `unaccent ILIKE`, `name ASC`) + contagem + nome de categoria
   * resolvido (o use case monta saldo/média a partir disto).
   */
  async listTrackedProducts(query: { search?: string; limit: number; offset: number }): Promise<{
    rows: TrackedStockProductRecord[];
    total: number;
  }> {
    const conditions: SQL[] = [eq(products.trackStock, true)];
    if (query.search) {
      const term = `%${normalizeAccents(query.search)}%`;
      conditions.push(sql`unaccent(${products.name}) ILIKE unaccent(${term})`);
    }
    const where = and(...conditions);

    const rows = await this.tx.query.products.findMany({
      where,
      limit: query.limit,
      offset: query.offset,
      orderBy: (p, { asc: asc_ }) => asc_(p.name),
    });
    const totalRow = await this.tx.select({ count: count() }).from(products).where(where);
    const categoryNames = await this.tx.query.categories.findMany({ columns: { id: true, name: true } });
    const catMap = new Map(categoryNames.map((c) => [c.id, c.name]));

    return {
      rows: rows.map((p) => ({
        productId: p.id,
        name: p.name,
        categoryId: p.categoryId,
        categoryName: p.categoryId ? catMap.get(p.categoryId) ?? null : null,
        unit: p.unit,
        costPrice: p.costPrice,
        lowStockThreshold: p.lowStockThreshold,
      })),
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  /** Linhas de `GET /stock/movements` (produto/usuário resolvidos, `createdAt DESC`). */
  async listMovements(query: { productId?: Id; limit: number; offset: number }): Promise<{
    rows: StockMovementViewRecord[];
    total: number;
  }> {
    const where = query.productId ? eq(stockMovements.productId, query.productId) : undefined;
    const rows = await this.tx
      .select({
        id: stockMovements.id,
        productId: stockMovements.productId,
        productName: products.name,
        type: stockMovements.type,
        quantityDelta: stockMovements.quantityDelta,
        unitCost: stockMovements.unitCost,
        orderId: stockMovements.orderId,
        note: stockMovements.note,
        userName: users.name,
        createdAt: stockMovements.createdAt,
      })
      .from(stockMovements)
      .leftJoin(products, eq(products.id, stockMovements.productId))
      .leftJoin(users, eq(users.id, stockMovements.createdBy))
      .where(where)
      .orderBy(desc(stockMovements.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    const totalRow = await this.tx.select({ count: count() }).from(stockMovements).where(where);
    return {
      rows: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        productName: r.productName,
        type: r.type,
        quantityDelta: r.quantityDelta,
        unitCost: r.unitCost,
        orderId: r.orderId,
        note: r.note,
        userName: r.userName,
        createdAt: r.createdAt,
      })),
      total: Number(totalRow[0]?.count ?? rows.length),
    };
  }

  /** Movimentos `sale` de um item — estorno em `deleteItem` lê o ledger, não flags. */
  async listSalesMovementsForItem(orderItemId: Id): Promise<Array<{ quantityDelta: number }>> {
    return this.tx
      .select({ quantityDelta: stockMovements.quantityDelta })
      .from(stockMovements)
      .where(and(eq(stockMovements.orderItemId, orderItemId), eq(stockMovements.type, "sale")));
  }

  /** Movimentos `sale` de uma comanda — estorno integral em `cancelOrder`. */
  async listSalesMovementsForOrder(orderId: Id): Promise<
    Array<{ productId: Id; orderItemId: Id | null; quantityDelta: number }>
  > {
    return this.tx
      .select({
        productId: stockMovements.productId,
        orderItemId: stockMovements.orderItemId,
        quantityDelta: stockMovements.quantityDelta,
      })
      .from(stockMovements)
      .where(and(eq(stockMovements.orderId, orderId), eq(stockMovements.type, "sale")));
  }
}

// =====================================================================
// Fluxo de caixa
// =====================================================================

export class PostgresCashFlowRepository implements CashFlowRepository {
  constructor(private readonly tx: Tx) {}

  /** SELECT ... FOR UPDATE da gaveta aberta (mesma trava de linha de `findOpenDrawerTxForUpdate`). */
  async findOpenForUpdate(): Promise<{ id: Id; openedAt: string } | null> {
    const rows = await this.tx
      .select({ id: cashDrawers.id, openedAt: cashDrawers.openedAt })
      .from(cashDrawers)
      .where(eq(cashDrawers.status, "open"))
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  }

  /**
   * Abre a gaveta. Checagem + unique index parcial `uq_cash_drawer_single_open`
   * replicam `openCashDrawerUsecase` (a corrida em duas requisições vira o
   * mesmo 409, não uma segunda gaveta). Audit/outbox são do use case
   * (`session.audit`/`session.outbox`).
   */
  async open(input: { actorId: Id; openingAmount: number }): Promise<{ id: Id; openedAt: string }> {
    const existing = await this.tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.status, "open") });
    if (existing) throw Errors.cashDrawerAlreadyOpen();
    try {
      const [row] = await this.tx
        .insert(cashDrawers)
        .values({ openedBy: input.actorId, openingAmount: round2(input.openingAmount) })
        .returning();
      if (!row) throw Errors.cashDrawerAlreadyOpen();
      return { id: row.id, openedAt: row.openedAt };
    } catch (err) {
      if (isUniqueViolationOn(err, "uq_cash_drawer_single_open")) throw Errors.cashDrawerAlreadyOpen();
      throw err;
    }
  }

  /**
   * Sangria/suprimento. As validações de domínio (categoria da lista
   * permitida, valor > 0, gaveta aberta) e audit/outbox ficam no use case
   * migrado; `category` cai no default "outros" do schema.
   *
   * ADIÇÃO (Onda 2): `refOrderId` (coluna real `ref_order_id` — estorno de
   * comanda cancelada rastreia a origem) e o retorno `{ id, amount }` (o
   * audit/outbox do cancelamento publicam `movementId`/`amount` gravados).
   */
  async recordMovement(input: {
    drawerId: Id;
    actorId: Id;
    type: "sangria" | "suprimento";
    amount: number;
    note?: string;
    refOrderId?: Id | null;
  }): Promise<{ id: Id; amount: number }> {
    const [row] = await this.tx
      .insert(cashDrawerMovements)
      .values({
        drawerId: input.drawerId,
        type: input.type,
        amount: input.amount,
        note: input.note ?? null,
        refOrderId: input.refOrderId ?? null,
        createdBy: input.actorId,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "drawerId" });
    return { id: row.id, amount: row.amount };
  }

  // TODO(onda de cash-flow): fechar gaveta calcula `closing_expected`
  // (opening + movimentos + pagamentos em dinheiro da comanda), diferença,
  // denominaçãoes e aproveitador — é o coração de `closeCashDrawerUsecase`.
  async close(_input: { drawerId: Id; actorId: Id; countedAmount: number }): Promise<void> {
    return notImplemented("CashFlowRepository.close — cálculo de expected/diferença (ver TODO no código)");
  }
}

// =====================================================================
// Compras
// =====================================================================

function toPurchaseRecord(p: typeof purchases.$inferSelect): PurchaseRecord {
  return {
    id: p.id,
    supplierId: p.supplierId,
    invoiceNumber: p.invoiceNumber,
    issuedOn: p.issuedOn,
    note: p.note,
    total: p.total,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
  };
}

export class PostgresPurchaseRepository implements PurchaseRepository {
  constructor(private readonly tx: Tx) {}

  /** Documento (sem linhas): o detalhe com itens continua no use case. */
  async findById(id: Id): Promise<PurchaseRecord | null> {
    const row = await this.tx.query.purchases.findFirst({ where: eq(purchases.id, id) });
    return row ? toPurchaseRecord(row) : null;
  }

  /** Cria o documento vazio (`total` = 0 até as linhas entrarem). */
  async create(input: { supplierId?: Id | null; actorId: Id }): Promise<PurchaseRecord> {
    const [row] = await this.tx
      .insert(purchases)
      .values({ supplierId: input.supplierId ?? null, createdBy: input.actorId })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "supplierId" });
    return toPurchaseRecord(row);
  }

  // TODO(onda de purchase): a linha real valida produto/rastreamento, recalcula
  // `total`, grava movimento `purchase` no ledger (unit_cost = valoração da
  // média móvel) e emite outbox `purchase.received` — transação única em
  // `createPurchaseUsecase`. Insert parcial aqui daria uma compra "meio
  // registrada"; implementar tudo de uma vez.
  async addItem(_input: { purchaseId: Id; productId: Id; quantity: number; unitCost: number }): Promise<void> {
    return notImplemented("PurchaseRepository.addItem — linha + ledger + média móvel (ver TODO no código)");
  }

  // TODO(onda de purchase): "finalizar" não existe como passo separado hoje
  // (documento + linhas + ledger são atômicos em `createPurchaseUsecase`).
  async finalize(_id: Id): Promise<void> {
    return notImplemented("PurchaseRepository.finalize — semântica a definir na onda de purchase");
  }
}

// =====================================================================
// Pagamentos (gateway Pagar.me V5)
// =====================================================================

function toPaymentRecord(p: typeof payments.$inferSelect): PaymentRecord {
  return {
    id: p.id,
    orderId: p.orderId,
    attempt: p.attempt,
    provider: p.provider,
    providerOrderId: p.providerOrderId,
    providerChargeId: p.providerChargeId,
    providerPaymentId: p.providerPaymentId,
    method: p.method,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    refundedAmount: p.refundedAmount,
    failureReason: p.failureReason,
    qrCode: p.qrCode,
    qrCodeBase64: p.qrCodeBase64,
    qrCodeUrl: p.qrCodeUrl,
    pixTxid: p.pixTxid,
    pixExpiresAt: p.pixExpiresAt,
    paidAt: p.paidAt,
    canceledAt: p.canceledAt,
    metadata: JSON.parse(p.metadata || "{}"),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<PaymentRecord | null> {
    const row = await this.tx.query.payments.findFirst({ where: eq(payments.id, id) });
    return row ? toPaymentRecord(row) : null;
  }

  /** Tentativas da comanda, na ordem em que foram criadas. */
  async findByOrder(orderId: Id): Promise<PaymentRecord[]> {
    const rows = await this.tx.query.payments.findMany({
      where: eq(payments.orderId, orderId),
      orderBy: asc(payments.attempt),
    });
    return rows.map(toPaymentRecord);
  }

  /**
   * INSERT puro: o cálculo de `attempt` (max+1 por comanda), a chamada ao
   * gateway e a checagem de valor ficam no use case (`createPaymentUsecase`),
   * como hoje. `uq_payment_order_attempt` é a última linha de defesa.
   */
  async create(input: Omit<PaymentRecord, "id">): Promise<PaymentRecord> {
    const [row] = await this.tx
      .insert(payments)
      .values({
        orderId: input.orderId,
        attempt: input.attempt,
        provider: input.provider,
        providerOrderId: input.providerOrderId ?? null,
        providerChargeId: input.providerChargeId ?? null,
        providerPaymentId: input.providerPaymentId ?? null,
        method: input.method,
        amount: input.amount,
        currency: input.currency ?? "BRL",
        status: input.status,
        refundedAmount: input.refundedAmount ?? 0,
        failureReason: input.failureReason ?? null,
        qrCode: input.qrCode ?? null,
        qrCodeBase64: input.qrCodeBase64 ?? null,
        qrCodeUrl: input.qrCodeUrl ?? null,
        pixTxid: input.pixTxid ?? null,
        pixExpiresAt: input.pixExpiresAt ?? null,
        paidAt: input.paidAt ?? null,
        canceledAt: input.canceledAt ?? null,
        metadata: toJsonText(input.metadata),
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "orderId" });
    return toPaymentRecord(row);
  }

  // TODO(onda de payment): a transição real vem do webhook/reconciliação e
  // faz muito mais que UPDATE de status — paidAt/canceledAt, merge de
  // metadata (providerData), payment_event, efeito na comanda (fecho/QR).
  // Replicar `processPaymentEventUsecase` de uma vez; UPDATE parcial aqui
  // deixaria o estado local mentindo sobre o gateway.
  async transition(_id: Id, _status: string, _providerData?: unknown): Promise<PaymentRecord> {
    return notImplemented("PaymentRepository.transition — semântica de webhook/reconciliação (ver TODO no código)");
  }
}

// =====================================================================
// Entregas
// =====================================================================

function toDeliveryRecord(d: typeof deliveries.$inferSelect): DeliveryRecord {
  return {
    id: d.id,
    orderId: d.orderId,
    courierId: d.courierId,
    address: d.address,
    distanceKm: d.distanceKm,
    estimatedMinutes: d.estimatedMinutes,
    status: d.status,
    dispatchedAt: d.dispatchedAt,
    deliveredAt: d.deliveredAt,
    notes: d.notes,
    createdAt: d.createdAt,
  };
}

export class PostgresDeliveryRepository implements DeliveryRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<DeliveryRecord | null> {
    const row = await this.tx.query.deliveries.findFirst({ where: eq(deliveries.id, id) });
    return row ? toDeliveryRecord(row) : null;
  }

  /** 1:1 com a comanda (`delivery.order_id` UNIQUE). */
  async findByOrder(orderId: Id): Promise<DeliveryRecord | null> {
    const row = await this.tx.query.deliveries.findFirst({ where: eq(deliveries.orderId, orderId) });
    return row ? toDeliveryRecord(row) : null;
  }

  /**
   * Mais recentes primeiro (visão do manager). Observação: as duas superfícies
   * atuais divergem — manager ordena `createdAt DESC`, courier `ASC`; quando a
   * rota migrar, alinhar a ordenação desejada aqui.
   */
  async list(query: PageQuery & { status?: DeliveryStatus; courierId?: Id }): Promise<Page<DeliveryRecord>> {
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(deliveries.status, query.status));
    if (query.courierId) conditions.push(eq(deliveries.courierId, query.courierId));
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.tx.query.deliveries.findMany({
      where,
      orderBy: desc(deliveries.createdAt),
      limit: query.limit,
      offset: query.offset,
    });
    const totalRow = await this.tx.select({ count: count() }).from(deliveries).where(where);
    return { data: rows.map(toDeliveryRecord), total: Number(totalRow[0]?.count ?? rows.length) };
  }

  /**
   * Só atribui (o status continua `awaiting_courier` até o dispatch, como
   * `assignCourierUsecase`). A validação de papel (`courier`), o alerta
   * direcionado e o audit ficam no use case migrado.
   */
  async assignCourier(id: Id, courierId: Id): Promise<DeliveryRecord> {
    const [row] = await this.tx
      .update(deliveries)
      .set({ courierId })
      .where(eq(deliveries.id, id))
      .returning();
    if (!row) throw Errors.notFound("Entrega");
    return toDeliveryRecord(row);
  }

  /**
   * Troca o status e carimba os timestamps que a máquina de estados usa
   * (`dispatchedAt` na saída para entrega, `deliveredAt` na entrega). A
   * validação de transição (`canTransitionDelivery`) continua no use case.
   */
  async transition(id: Id, status: DeliveryStatus): Promise<DeliveryRecord> {
    const now = new Date().toISOString();
    const [row] = await this.tx
      .update(deliveries)
      .set({
        status,
        ...(status === "out_for_delivery" ? { dispatchedAt: now } : {}),
        ...(status === "delivered" ? { deliveredAt: now } : {}),
      })
      .where(eq(deliveries.id, id))
      .returning();
    if (!row) throw Errors.notFound("Entrega");
    return toDeliveryRecord(row);
  }

  /** ADIÇÃO (Onda 2): lote por comandas — hidratação da listagem sem N+1. */
  async listByOrderIds(ids: Id[]): Promise<DeliveryRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.query.deliveries.findMany({ where: inArray(deliveries.orderId, ids) });
    return rows.map(toDeliveryRecord);
  }
}

// =====================================================================
// Alertas (sino) — ADIÇÃO (Onda 2)
// =====================================================================

/**
 * Recorte de visibilidade do sino — MESMO predicado da função `visibleTo`
 * original (auditada em `alert.usecases.ts`): audiência vazia (NULL) ou
 * cardinalidade 0 é para todos; senão, o papel (e/ou o token `user:<id>` de
 * quem pergunta) precisa estar na lista. O `mark-read` usa o mesmo WHERE —
 * se divergissem, o "marcar todas" do garçom limparia o contador do gerente.
 */
function alertVisibleTo(role: string, userId?: string | null): SQL {
  const tokens = userId ? [role, alertUserToken(userId)] : [role];
  return or(
    isNull(alerts.audienceRoles),
    sql`cardinality(${alerts.audienceRoles}) = 0`,
    ...tokens.map((token) => sql`${token} = ANY(${alerts.audienceRoles})`),
  )!;
}

function toAlertRecord(r: typeof alerts.$inferSelect): AlertRecord {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    orderId: r.orderId,
    channel: r.channel,
    audienceRoles: r.audienceRoles,
    readAt: r.readAt,
    createdAt: r.createdAt,
  };
}

export class PostgresAlertRepository implements AlertRepository {
  constructor(private readonly tx: Tx) {}

  async create(input: {
    kind: string;
    title: string;
    body?: string | null;
    orderId?: Id | null;
    channel?: string | null;
    audienceRoles: string[];
  }): Promise<AlertRecord> {
    const [row] = await this.tx
      .insert(alerts)
      .values({
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        orderId: input.orderId ?? null,
        channel: input.channel ?? null,
        audienceRoles: input.audienceRoles,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "title" });
    return toAlertRecord(row);
  }

  async listVisible(query: {
    role: string;
    userId?: Id | null;
    limit: number;
    unreadOnly?: boolean;
  }): Promise<AlertRecord[]> {
    const conditions: SQL[] = [alertVisibleTo(query.role, query.userId)];
    if (query.unreadOnly) conditions.push(isNull(alerts.readAt));
    const rows = await this.tx.query.alerts.findMany({
      where: and(...conditions),
      orderBy: [desc(alerts.createdAt), desc(alerts.seq)],
      limit: query.limit,
    });
    return rows.map(toAlertRecord);
  }

  async countVisible(query: { role: string; userId?: Id | null }): Promise<{ total: number; unread: number }> {
    const [counts] = await this.tx
      .select({
        total: sql<number>`count(*)::int`,
        unread: sql<number>`count(*) filter (where ${alerts.readAt} is null)::int`,
      })
      .from(alerts)
      .where(alertVisibleTo(query.role, query.userId));
    return { total: counts?.total ?? 0, unread: counts?.unread ?? 0 };
  }

  async markRead(query: { role: string; userId?: Id | null; orderId?: Id }): Promise<number> {
    const conditions: SQL[] = [alertVisibleTo(query.role, query.userId), isNull(alerts.readAt)];
    if (query.orderId) conditions.push(eq(alerts.orderId, query.orderId));
    const marked = await this.tx
      .update(alerts)
      .set({ readAt: new Date().toISOString() })
      .where(and(...conditions))
      .returning({ id: alerts.id });
    return marked.length;
  }
}

// =====================================================================
// Audit log (espelha `logAction`)
// =====================================================================

export class PostgresAuditWriter implements AuditWriter {
  constructor(private readonly tx: Tx) {}

  /**
   * `audit_log` não tem colunas `entity_type`/`entity_id` (a spec os previa):
   * aqui eles são FOLDADOS no JSON de `details`, e `actorId: null` vira o
   * usuário técnico `system` (a coluna `user_id` é NOT NULL + FK — mesmo
   * destino que os eventos self-service já usam hoje).
   */
  async record(input: {
    actorId: Id | null;
    action: string;
    entityType?: string;
    entityId?: Id | null;
    orderId?: Id | null;
    details?: unknown;
  }): Promise<void> {
    const details: Record<string, unknown> =
      input.details !== null && typeof input.details === "object" && !Array.isArray(input.details)
        ? { ...(input.details as Record<string, unknown>) }
        : input.details !== undefined
          ? { details: input.details }
          : {};
    if (input.entityType !== undefined) details.entityType = input.entityType;
    if (input.entityId !== undefined && input.entityId !== null) details.entityId = input.entityId;

    await this.tx.insert(auditLog).values({
      userId: input.actorId ?? SYSTEM_USER_ID,
      action: input.action,
      orderId: input.orderId ?? null,
      details: JSON.stringify(details),
    });
  }
}

// =====================================================================
// Outbox (espelha `enqueueEvent`)
// =====================================================================

export class PostgresOutboxWriter implements OutboxWriter {
  constructor(private readonly tx: Tx) {}

  /**
   * `room` obrigatório (coluna real) e `type` → `eventType`, exatamente como
   * `enqueueEvent(tx, room, eventType, payload)`.
   *
   * `aggregateId` NÃO tem coluna própria em `outbox_event`: quando o caller
   * passa `payload`, ele é gravado como veio (id dentro do payload, como todos
   * os `enqueueEvent` atuais fazem); quando não passa, vira
   * `{"aggregateId": "..."}` para não se perder. Se um dia o id precisar ser
   * consultável fora do payload, é uma coluna nova em migration própria.
   */
  async enqueue(input: { room: string; type: string; aggregateId: Id; payload?: unknown }): Promise<void> {
    await this.tx.insert(outboxEvents).values({
      room: input.room,
      eventType: input.type,
      payload: input.payload === undefined ? JSON.stringify({ aggregateId: input.aggregateId }) : toJsonText(input.payload, "{}"),
    });
  }
}

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
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "./client.js";
import {
  auditLog,
  cashDrawers,
  cashDrawerMovements,
  categories,
  customers,
  deliveries,
  kitchenGroups,
  orderItems,
  orders,
  outboxEvents,
  payments,
  products,
  purchases,
  stockMovements,
  users,
} from "./schema.js";
import { isUniqueViolationOn } from "./errors.js";
import type {
  AuditWriter,
  CashFlowRepository,
  CatalogRepository,
  CustomerRecord,
  CustomerRepository,
  DeliveryRecord,
  DeliveryRepository,
  DeliveryStatus,
  Id,
  OrderRecord,
  OrderRepository,
  Page,
  PageQuery,
  PaymentRecord,
  PaymentRepository,
  ProductRecord,
  PurchaseRecord,
  PurchaseRepository,
  StockRepository,
  UserRecord,
  UserRepository,
  OutboxWriter,
} from "../../application/ports/repositories.js";
import { Errors } from "../../domain/errors.js";
import { SYSTEM_USER_ID } from "../../domain/constants.js";
import { round2 } from "../../domain/money.js";
import { normalizeAccents } from "../../domain/text.js";

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
    active: p.active,
    imagePath: p.imagePath,
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
  async saveProduct(input: Partial<ProductRecord> & Pick<ProductRecord, "name" | "price">): Promise<ProductRecord> {
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
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.imagePath !== undefined ? { imagePath: input.imagePath } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(products.id, input.id))
        .returning();
      if (!row) throw Errors.notFound("Produto");
      return toProductRecord(row);
    }

    const [row] = await this.tx
      .insert(products)
      .values({
        categoryId: input.categoryId ?? null,
        kitchenGroupId: input.kitchenGroupId ?? null,
        name: input.name,
        description: input.description ?? "",
        price: input.price,
        active: input.active ?? true,
        imagePath: input.imagePath ?? null,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "name" });
    return toProductRecord(row);
  }

  async listCategories(): Promise<Array<{ id: Id; name: string; active: boolean }>> {
    const rows = await this.tx.query.categories.findMany({ orderBy: asc(categories.displayOrder) });
    return rows.map((c) => ({ id: c.id, name: c.name, active: c.active }));
  }

  async listKitchenGroups(): Promise<Array<{ id: Id; name: string }>> {
    const rows = await this.tx.query.kitchenGroups.findMany({ orderBy: asc(kitchenGroups.displayOrder) });
    return rows.map((g) => ({ id: g.id, name: g.name }));
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
   */
  async recordMovement(input: {
    productId: Id;
    quantityDelta: number;
    type: "sale" | "refund" | "purchase" | "adjustment";
    unitCost?: number;
    orderItemId?: Id;
    note?: string;
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
   */
  async recordMovement(input: {
    drawerId: Id;
    actorId: Id;
    type: "sangria" | "suprimento";
    amount: number;
    note?: string;
  }): Promise<void> {
    await this.tx.insert(cashDrawerMovements).values({
      drawerId: input.drawerId,
      type: input.type,
      amount: input.amount,
      note: input.note ?? null,
      createdBy: input.actorId,
    });
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
    arrivalAlertSent: d.arrivalAlertSent,
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

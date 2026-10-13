import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Tx } from "../client.js";
import { cashDrawerMovements, cashDrawers, orderPayments, orders, restaurantTables } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import { isUniqueViolationOn } from "../errors.js";
import { round2 } from "../../../domain/money.js";
import type {
  CashDrawerRecord,
  CashFlowRepository,
  CashMovementRecord,
  CashPaymentRecord,
  CashSaleRecord,
  Id,
  PageQuery,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Fluxo de caixa
// =====================================================================

/** Linha completa de `cash_drawer` (fiel ao schema). */
function toCashDrawerRecord(d: typeof cashDrawers.$inferSelect): CashDrawerRecord {
  return {
    id: d.id,
    status: d.status,
    openedAt: d.openedAt,
    openedBy: d.openedBy,
    openingAmount: d.openingAmount,
    note: d.note,
    closedAt: d.closedAt,
    closedBy: d.closedBy,
    closingExpected: d.closingExpected,
    closingCounted: d.closingCounted,
    closingDifference: d.closingDifference,
    closingNote: d.closingNote,
    closingDenominations: d.closingDenominations,
    closingJustification: d.closingJustification,
    closingApprovedBy: d.closingApprovedBy,
  };
}

/** Linha de `cash_drawer_movement` (fiel ao schema). */
function toCashMovementRecord(m: typeof cashDrawerMovements.$inferSelect): CashMovementRecord {
  return {
    id: m.id,
    drawerId: m.drawerId,
    type: m.type,
    amount: m.amount,
    note: m.note,
    refOrderId: m.refOrderId,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    category: m.category,
  };
}

export class PostgresCashFlowRepository implements CashFlowRepository {
  constructor(private readonly tx: Tx) {}

  /** Gaveta aberta SEM lock (mesma leitura de `findOpenDrawerTx`). */
  async findOpen(): Promise<CashDrawerRecord | null> {
    const row = await this.tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.status, "open") });
    return row ? toCashDrawerRecord(row) : null;
  }

  /** SELECT ... FOR UPDATE da gaveta aberta (mesma trava de linha de `findOpenDrawerTxForUpdate`). */
  async findOpenForUpdate(): Promise<CashDrawerRecord | null> {
    const rows = await this.tx
      .select()
      .from(cashDrawers)
      .where(eq(cashDrawers.status, "open"))
      .limit(1)
      .for("update");
    return rows[0] ? toCashDrawerRecord(rows[0]) : null;
  }

  /**
   * Abre a gaveta. Checagem + unique index parcial `uq_cash_drawer_single_open`
   * replicam `openCashDrawerUsecase` (a corrida em duas requisições vira o
   * mesmo 409, não uma segunda gaveta). Audit/outbox são do use case
   * (`session.audit`/`session.outbox`).
   */
  async open(input: {
    actorId: Id;
    openingAmount: number;
    note?: string | null;
    openedAt: string;
  }): Promise<CashDrawerRecord> {
    const existing = await this.tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.status, "open") });
    if (existing) throw Errors.cashDrawerAlreadyOpen();
    try {
      const [row] = await this.tx
        .insert(cashDrawers)
        .values({
          openedBy: input.actorId,
          openingAmount: round2(input.openingAmount),
          note: input.note ?? null,
          openedAt: input.openedAt,
        })
        .returning();
      if (!row) throw Errors.cashDrawerAlreadyOpen();
      return toCashDrawerRecord(row);
    } catch (err) {
      if (isUniqueViolationOn(err, "uq_cash_drawer_single_open")) throw Errors.cashDrawerAlreadyOpen();
      throw err;
    }
  }

  /**
   * Sangria/suprimento. As validações de domínio (categoria da lista
   * permitida, valor > 0, gaveta aberta) e audit/outbox ficam no use case
   * migrado; `category` cai no default "outros" do schema quando ausente.
   *
   * ADIÇÃO (Onda 2): `refOrderId` (coluna real `ref_order_id` — estorno de
   * comanda cancelada rastreia a origem) e o retorno com id/amount (o
   * audit/outbox do cancelamento publicam `movementId`/`amount` gravados).
   * ADIÇÃO (Onda cash-flow): `category` e linha completa no retorno.
   */
  async recordMovement(input: {
    drawerId: Id;
    actorId: Id;
    type: "sangria" | "suprimento";
    amount: number;
    note?: string;
    refOrderId?: Id | null;
    category?: string;
  }): Promise<CashMovementRecord> {
    const [row] = await this.tx
      .insert(cashDrawerMovements)
      .values({
        drawerId: input.drawerId,
        type: input.type,
        amount: input.amount,
        note: input.note ?? null,
        refOrderId: input.refOrderId ?? null,
        createdBy: input.actorId,
        ...(input.category !== undefined ? { category: input.category } : {}),
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "drawerId" });
    return toCashMovementRecord(row);
  }

  /**
   * Fechamento. O cálculo de `expected`/diferença/denominações e as validações
   * (tolerância, alçada de aprovação) são do USE CASE — aqui só a escrita dos
   * campos já resolvidos, como a `update(...).set({...}).returning()` original.
   */
  async close(input: {
    drawerId: Id;
    closedBy: Id;
    closedAt: string;
    closingExpected: number;
    closingCounted: number;
    closingDifference: number;
    closingNote: string | null;
    closingDenominations: string | null;
    closingJustification: string | null;
    closingApprovedBy: string | null;
  }): Promise<CashDrawerRecord> {
    const [row] = await this.tx
      .update(cashDrawers)
      .set({
        status: "closed",
        closedAt: input.closedAt,
        closedBy: input.closedBy,
        closingExpected: input.closingExpected,
        closingCounted: input.closingCounted,
        closingDifference: input.closingDifference,
        closingNote: input.closingNote,
        closingDenominations: input.closingDenominations,
        closingJustification: input.closingJustification,
        closingApprovedBy: input.closingApprovedBy,
      })
      .where(eq(cashDrawers.id, input.drawerId))
      .returning();
    if (!row) throw Errors.notFound("Caixa");
    return toCashDrawerRecord(row);
  }

  /** Gaveta por id (`GET /cash-drawer/:id`). */
  async findById(id: Id): Promise<CashDrawerRecord | null> {
    const row = await this.tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.id, id) });
    return row ? toCashDrawerRecord(row) : null;
  }

  /** `GET /cash-drawer`: mais recentes primeiro (`openedAt DESC`). */
  async list(query: PageQuery): Promise<CashDrawerRecord[]> {
    const rows = await this.tx.query.cashDrawers.findMany({
      orderBy: desc(cashDrawers.openedAt),
      limit: query.limit,
      offset: query.offset,
    });
    return rows.map(toCashDrawerRecord);
  }

  /**
   * `GET /cash-drawer/summary`: sessões que intersectam `[from, to]`. Sessão
   * aberta (`closed_at` NULL) entra desde que tenha aberto até `to` — o
   * `closed_at ?? now` não coalesce em `.where()`, então a condição é explícita.
   */
  async listIntersecting(from: string, to: string): Promise<CashDrawerRecord[]> {
    const rows = await this.tx
      .select()
      .from(cashDrawers)
      .where(
        and(
          lte(cashDrawers.openedAt, to),
          or(gte(cashDrawers.closedAt, from), isNull(cashDrawers.closedAt))
        )
      )
      .orderBy(desc(cashDrawers.openedAt));
    return rows.map(toCashDrawerRecord);
  }

  /** Movimentos da gaveta, mais recentes primeiro (mesma query de `movementsFor`). */
  async listMovements(drawerId: Id): Promise<CashMovementRecord[]> {
    const rows = await this.tx
      .select()
      .from(cashDrawerMovements)
      .where(eq(cashDrawerMovements.drawerId, drawerId))
      .orderBy(desc(cashDrawerMovements.createdAt));
    return rows.map(toCashMovementRecord);
  }

  /**
   * Vendas em dinheiro confirmadas na janela (mesma query de
   * `cashPaymentsBetween`): sem JOIN — o resumo só soma `amount` e conta linhas.
   */
  async listCashPaymentsBetween(from: string, to: string): Promise<CashPaymentRecord[]> {
    return this.tx
      .select({
        amount: orderPayments.amount,
        received: orderPayments.received,
        change: orderPayments.change,
        confirmedAt: orderPayments.confirmedAt,
        orderId: orderPayments.orderId,
      })
      .from(orderPayments)
      .where(
        and(
          eq(orderPayments.method, "cash"),
          eq(orderPayments.confirmed, true),
          gte(orderPayments.confirmedAt, from),
          lte(orderPayments.confirmedAt, to)
        )
      );
  }

  /**
   * Detalhe de `GET /cash-drawer/:id`: mesmos JOINs/filtros da query original
   * (`order_payment` × `order` LEFT JOIN `restaurant_table`), sem `orderBy`.
   */
  async listCashSalesBetween(from: string, to: string): Promise<CashSaleRecord[]> {
    return this.tx
      .select({
        orderId: orderPayments.orderId,
        tabLabel: orders.tabLabel,
        tableNumber: restaurantTables.number,
        amount: orderPayments.amount,
        received: orderPayments.received,
        change: orderPayments.change,
        confirmedAt: orderPayments.confirmedAt,
      })
      .from(orderPayments)
      .innerJoin(orders, eq(orders.id, orderPayments.orderId))
      .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
      .where(
        and(
          eq(orderPayments.method, "cash"),
          eq(orderPayments.confirmed, true),
          gte(orderPayments.confirmedAt, from),
          lte(orderPayments.confirmedAt, to)
        )
      );
  }
}


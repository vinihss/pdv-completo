import { and, eq, gte, lte, desc, or, isNull } from "drizzle-orm";
import { db, type Tx } from "../../infra/db/client.js";
import {
  cashDrawers,
  cashDrawerMovements,
  orderPayments,
  orders,
  restaurantTables,
  users,
} from "../../infra/db/schema.js";
import { isUniqueViolationOn } from "../../infra/db/errors.js";
import { Errors } from "../../domain/errors.js";
import { round2, moneyEq } from "../../domain/money.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

// Mesma regra de async do order.usecases.ts: dentro de
// `db.transaction(async (tx) => ...)` tudo é awaited. Timestamps de abertura e
// fechamento do caixa são gravados como ISO 8601 UTC explícito para que a
// comparação com `order_payment.confirmed_at` (que também é ISO) seja
// lexicograficamente consistente — o padrão `(current_timestamp)` do SQL não
// seria (espaço vs "T" no separador de data/hora).
const CASH_DRAWER_ROOM = "cash-drawer";

function serializeDrawer(d: typeof cashDrawers.$inferSelect) {
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
  };
}

function serializeMovement(m: typeof cashDrawerMovements.$inferSelect) {
  return {
    id: m.id,
    type: m.type,
    amount: m.amount,
    note: m.note,
    refOrderId: m.refOrderId,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
  };
}

// Rótulo de exibição da comanda de um estorno (ref_order_id): rótulo da
// comanda, nº da mesa ou fallback pro id. Same join usado no detail de vendas.
async function orderLabelOf(tx: Tx, orderId: string): Promise<string> {
  const [row] = await tx
    .select({ tabLabel: orders.tabLabel, tableNumber: restaurantTables.number })
    .from(orders)
    .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
    .where(eq(orders.id, orderId));
  return row?.tabLabel ?? (row?.tableNumber != null ? `Mesa ${row.tableNumber}` : orderId);
}

async function serializeMovements(tx: Tx, movements: (typeof cashDrawerMovements.$inferSelect)[]) {
  // Sequencial de propósito: dentro de `db.transaction` todas as queries
  // compartilham UM único client do node-postgres, e `Promise.all` ali é
  // query concorrente no mesmo client (pg serializa por baixo e emite
  // DeprecationWarning "client is already executing a query", removido no
  // pg@9). Não custa tempo: o paralelismo não existia.
  const out: Array<
    ReturnType<typeof serializeMovement> & { createdByName: string | null; refOrderLabel: string | null }
  > = [];
  for (const m of movements) {
    out.push({
      ...serializeMovement(m),
      createdByName: await nameOf(tx, m.createdBy),
      refOrderLabel: m.refOrderId ? await orderLabelOf(tx, m.refOrderId) : null,
    });
  }
  return out;
}

async function nameOf(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await tx.query.users.findFirst({ where: eq(users.id, userId) });
  return u?.name ?? null;
}

// Vendas em dinheiro confirmadas dentro do período da sessão — a fonte das
// entradas do caixa (order_payment é a fonte da verdade do pagamento).
async function cashPaymentsBetween(tx: Tx, from: string, to: string) {
  return tx
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

async function movementsFor(tx: Tx, drawerId: string) {
  return tx
    .select()
    .from(cashDrawerMovements)
    .where(eq(cashDrawerMovements.drawerId, drawerId))
    .orderBy(desc(cashDrawerMovements.createdAt));
}

// Esperado = fundo inicial + vendas em dinheiro confirmadas no período
// + suprimentos − sangrias. Calculado sempre dentro da transação da operação
// para não divergir do estado persistido em paralelo.
async function computeCashSummary(tx: Tx, drawer: typeof cashDrawers.$inferSelect) {
  const upper = drawer.closedAt ?? new Date().toISOString();
  const sales = await cashPaymentsBetween(tx, drawer.openedAt, upper);
  const movements = await movementsFor(tx, drawer.id);
  const salesSum = round2(sales.reduce((acc, r) => acc + r.amount, 0));
  const manualSum = movements.reduce(
    (acc, m) => acc + (m.type === "sangria" ? -m.amount : m.amount),
    0
  );
  return {
    expected: round2(drawer.openingAmount + salesSum + manualSum),
    sales,
    salesSum,
    movements,
  };
}

// Find the único caixa aberto — usado internamente e também pelo
// order.usecases (bloqueio de pagamento em dinheiro e estorno em sangria).
// Retorna o drawer dentro do mesmo tx da operação que chama.
export async function findOpenDrawerTx(tx: Tx): Promise<typeof cashDrawers.$inferSelect | undefined> {
  return tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.status, "open") });
}

// ---------- GET /cash-drawer/current ----------
export async function getCurrentDrawerUsecase() {
  return db.transaction(async (tx) => {
    const open = await findOpenDrawerTx(tx);
    if (!open) return null;
    const summary = await computeCashSummary(tx, open);
    // Sequencial: um client por transação (ver serializeMovements).
    const openedByName = await nameOf(tx, open.openedBy);
    const movements = await serializeMovements(tx, summary.movements);
    return {
      ...serializeDrawer(open),
      openedByName,
      expectedCash: summary.expected,
      cashSalesTotal: summary.salesSum,
      cashSalesCount: summary.sales.length,
      movements,
    };
  });
}

// ---------- GET /cash-drawer ----------
export async function listCashDrawersUsecase(input: { limit: number; offset: number }) {
  const rows = await db.query.cashDrawers.findMany({
    orderBy: desc(cashDrawers.openedAt),
    limit: input.limit,
    offset: input.offset,
  });
  const data = rows.map(serializeDrawer);
  return { data };
}

// ---------- GET /cash-drawer/:id ----------
export async function getCashDrawerDetailUsecase(id: string) {
  return db.transaction(async (tx) => {
    const drawer = await tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.id, id) });
    if (!drawer) throw Errors.notFound("Caixa");
    const summary = await computeCashSummary(tx, drawer);

    const salesRows = await tx
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
          gte(orderPayments.confirmedAt, drawer.openedAt),
          lte(orderPayments.confirmedAt, drawer.closedAt ?? new Date().toISOString())
        )
      )
      .orderBy(desc(orderPayments.confirmedAt));

    // Sequencial: um client por transação (ver serializeMovements).
    const openedByName = await nameOf(tx, drawer.openedBy);
    const closedByName = await nameOf(tx, drawer.closedBy);
    const movements = await serializeMovements(tx, summary.movements);

    return {
      ...serializeDrawer(drawer),
      openedByName,
      closedByName,
      expectedCash: summary.expected,
      cashSalesTotal: summary.salesSum,
      movements,
      cashSales: salesRows.map((r) => ({
        orderId: r.orderId,
        label: r.tabLabel ?? (r.tableNumber ? `Mesa ${r.tableNumber}` : null) ?? r.orderId,
        amount: round2(r.amount),
        received: r.received,
        change: r.change,
        confirmedAt: r.confirmedAt,
      })),
    };
  });
}

// ---------- POST /cash-drawer/open ----------
export async function openCashDrawerUsecase(input: { userId: string; openingAmount: number; note?: string }) {
  return db.transaction(async (tx) => {
    // O índice único parcial uq_cash_drawer_single_open (status='open') é a
    // garantia final de "uma sessão por vez": se duas requisições passarem
    // pela checagem, o INSERT de uma delas viola o índice e ela recebe o
    // mesmo erro de domínio em vez de abrir uma segunda gaveta.
    if (await findOpenDrawerTx(tx)) throw Errors.cashDrawerAlreadyOpen();
    const openedAt = new Date().toISOString();
    let drawer: typeof cashDrawers.$inferSelect;
    try {
      [drawer] = await tx
        .insert(cashDrawers)
        .values({
          openedBy: input.userId,
          openingAmount: round2(input.openingAmount),
          note: input.note ?? null,
          openedAt,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolationOn(err, "uq_cash_drawer_single_open")) {
        throw Errors.cashDrawerAlreadyOpen();
      }
      throw err;
    }
    await logAction(tx, input.userId, "cash_drawer_opened", null, {
      drawerId: drawer.id,
      openingAmount: drawer.openingAmount,
    });
    await enqueueEvent(tx, CASH_DRAWER_ROOM, "cash_drawer.opened", {
      drawerId: drawer.id,
      openingAmount: drawer.openingAmount,
    });
    return serializeDrawer(drawer);
  });
}

// ---------- POST /cash-drawer/sangria, POST /cash-drawer/suprimento ----------
export async function registerCashMovementUsecase(input: {
  userId: string;
  type: "sangria" | "suprimento";
  amount: number;
  note?: string;
}) {
  return db.transaction(async (tx) => {
    const drawer = await findOpenDrawerTx(tx);
    if (!drawer) throw Errors.cashDrawerNotOpen();

    if (input.type === "sangria") {
      const summary = await computeCashSummary(tx, drawer);
      const over = round2(input.amount) - summary.expected;
      if (over > 0 && !moneyEq(input.amount, summary.expected)) {
        throw Errors.cashWithdrawalExceedsAvailable(summary.expected);
      }
    }

    const [movement] = await tx
      .insert(cashDrawerMovements)
      .values({
        drawerId: drawer.id,
        type: input.type,
        amount: round2(input.amount),
        note: input.note ?? null,
        createdBy: input.userId,
      })
      .returning();

    const action = input.type === "sangria" ? "cash_drawer_sangria" : "cash_drawer_suprimento";
    const eventType = input.type === "sangria" ? "cash_drawer.sangria" : "cash_drawer.suprimento";
    await logAction(tx, input.userId, action, null, {
      drawerId: drawer.id,
      amount: movement.amount,
      note: movement.note,
    });
    await enqueueEvent(tx, CASH_DRAWER_ROOM, eventType, {
      drawerId: drawer.id,
      amount: movement.amount,
    });
    return serializeMovement(movement);
  });
}

// ---------- POST /cash-drawer/close ----------
export async function closeCashDrawerUsecase(input: {
  userId: string;
  countedAmount: number;
  note?: string;
}) {
  return db.transaction(async (tx) => {
    const drawer = await findOpenDrawerTx(tx);
    if (!drawer) throw Errors.cashDrawerNotOpen();

    const summary = await computeCashSummary(tx, drawer);
    const expected = summary.expected;
    const counted = round2(input.countedAmount);
    const difference = round2(counted - expected);
    const closedAt = new Date().toISOString();

    const [closed] = await tx
      .update(cashDrawers)
      .set({
        status: "closed",
        closedAt,
        closedBy: input.userId,
        closingExpected: expected,
        closingCounted: counted,
        closingDifference: difference,
        closingNote: input.note ?? null,
      })
      .where(eq(cashDrawers.id, drawer.id))
      .returning();

    await logAction(tx, input.userId, "cash_drawer_closed", null, {
      drawerId: drawer.id,
      openedBy: drawer.openedBy,
      openingAmount: drawer.openingAmount,
      expected,
      counted,
      difference,
      note: input.note ?? null,
    });
    await enqueueEvent(tx, CASH_DRAWER_ROOM, "cash_drawer.closed", {
      drawerId: drawer.id,
      expected,
      counted,
      difference,
    });
    return { ...serializeDrawer(closed), cashSalesTotal: summary.salesSum };
  });
}

// ---------- GET /cash-drawer/summary ----------
// Agrega a conferência das sessões que interseccionam [from, to]: esperado,
// contado e diferença por caixa, com totais para o relatório do gerente.
export async function sumCashDrawersSummaryUsecase(input: { from: string; to: string }) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(cashDrawers)
      // Interseção: a sessão não fechou antes de `from` nem abriu depois de `to`.
      // Sessão ainda aberta (closed_at NULL) entra desde que tenha aberto até `to`
      // — `closed_at ?? now` não coalesce em .where(), então a condição é explícita.
      .where(
        and(
          lte(cashDrawers.openedAt, input.to),
          or(gte(cashDrawers.closedAt, input.from), isNull(cashDrawers.closedAt))
        )
      )
      .orderBy(desc(cashDrawers.openedAt));

    // Sessão a sessão, sequencial: é o mesmo client da transação, então o
    // `Promise.all` por cima não dá paralelismo — só a depreciação do pg.
    const sessions: Array<
      ReturnType<typeof serializeDrawer> & {
        openedByName: string | null;
        cashSalesTotal: number;
        cashSalesCount: number;
        expected: number | null;
        counted: number | null;
        difference: number | null;
      }
    > = [];
    for (const d of rows) {
      const summary = await computeCashSummary(tx, d);
      sessions.push({
        ...serializeDrawer(d),
        openedByName: await nameOf(tx, d.openedBy),
        cashSalesTotal: summary.salesSum,
        cashSalesCount: summary.sales.length,
        expected: d.closedAt != null ? d.closingExpected : summary.expected,
        counted: d.closingCounted,
        difference: d.closingDifference,
      });
    }

    const closedSessions = sessions.filter((s) => s.status === "closed");
    const sum = (sel: (s: (typeof sessions)[number]) => number | null | undefined) =>
      round2(sessions.reduce((acc, s) => acc + (sel(s) ?? 0), 0));

    // Totais de conferência contam apenas sessões fechadas: `closing_expected`
    // e `closing_counted` só existem depois do fechamento, e contá-lo senão
    // misturaria o "esperado ao vivo" com o contado das fechadas (diferença
    // distorcida). Fundo/vendas incluem o que já entrou, mesmo em aberto.
    const totalOpening = sum((s) => s.openingAmount);
    const totalSales = sum((s) => s.cashSalesTotal);
    const totalExpected = round2(closedSessions.reduce((acc, s) => acc + (s.expected ?? 0), 0));
    const totalCounted = round2(closedSessions.reduce((acc, s) => acc + (s.counted ?? 0), 0));
    const totalDifference = round2(totalCounted - totalExpected);
    const openExpected = round2(
      sessions.filter((s) => s.status === "open").reduce((acc, s) => acc + (s.expected ?? 0), 0)
    );

    return {
      sessions,
      totalOpening,
      totalSales,
      totalExpected,
      totalCounted,
      totalDifference,
      openCount: sessions.filter((s) => s.status === "open").length,
      openExpected,
    };
  });
}
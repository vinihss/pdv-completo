import { and, eq, gte, lte, desc } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import {
  cashDrawers,
  cashDrawerMovements,
  orderPayments,
  orders,
  restaurantTables,
  users,
} from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";
import { round2, moneyEq } from "../../domain/money.js";
import { logAction } from "../../infra/audit-log.js";
import { enqueueEvent } from "../../infra/realtime/outbox-dispatcher.js";

// Masma regra de sync vs async do order.usecases.ts: dentro de
// `db.transaction(cb)` o driver better-sqlite3 é síncrono (`.run()`,
// `.get()`, `.all()`, `.sync()` — nunca `await`). Timestamps de abertura e
// fechamento do caixa são gravados como ISO 8601 UTC explícito para que a
// comparação com `order_payment.confirmed_at` (que também é ISO) seja
// lexicograficamente consistente — o padrão SQLite `(current_timestamp)` não
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
  };
}

function serializeMovement(m: typeof cashDrawerMovements.$inferSelect) {
  return { id: m.id, type: m.type, amount: m.amount, note: m.note, createdBy: m.createdBy, createdAt: m.createdAt };
}

function nameOf(tx: any, userId: string | null): string | null {
  if (!userId) return null;
  const u = tx.query.users.findFirst({ where: eq(users.id, userId) }).sync();
  return u?.name ?? null;
}

// Vendas em dinheiro confirmadas dentro do período da sessão — a fonte das
// entradas do caixa (order_payment é a fonte da verdade do pagamento).
function cashPaymentsBetween(tx: any, from: string, to: string) {
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
    )
    .all();
}

function movementsFor(tx: any, drawerId: string) {
  return tx
    .select()
    .from(cashDrawerMovements)
    .where(eq(cashDrawerMovements.drawerId, drawerId))
    .orderBy(desc(cashDrawerMovements.createdAt))
    .all();
}

// Esperado = fundo inicial + vendas em dinheiro confirmadas no período
// + suprimentos − sangrias. Calculado sempre dentro da transação da operação
// para não divergir do estado persistido em paralelo.
function computeCashSummary(tx: any, drawer: typeof cashDrawers.$inferSelect) {
  const upper = drawer.closedAt ?? new Date().toISOString();
  const sales = cashPaymentsBetween(tx, drawer.openedAt, upper);
  const movements = movementsFor(tx, drawer.id);
  const salesSum = round2(sales.reduce((acc: number, r: { amount: number }) => acc + r.amount, 0));
  const manualSum = movements.reduce(
    (acc: number, m: { type: "sangria" | "suprimento"; amount: number }) => acc + (m.type === "sangria" ? -m.amount : m.amount),
    0
  );
  return {
    expected: round2(drawer.openingAmount + salesSum + manualSum),
    sales,
    salesSum,
    movements,
  };
}

function findOpenDrawer(tx: any): typeof cashDrawers.$inferSelect | undefined {
  return tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.status, "open") }).sync();
}

// ---------- GET /cash-drawer/current ----------
export async function getCurrentDrawerUsecase() {
  return db.transaction((tx) => {
    const open = findOpenDrawer(tx);
    if (!open) return null;
    const summary = computeCashSummary(tx, open);
    return {
      ...serializeDrawer(open),
      openedByName: nameOf(tx, open.openedBy),
      expectedCash: summary.expected,
      cashSalesTotal: summary.salesSum,
      cashSalesCount: summary.sales.length,
      movements: summary.movements.map((m: typeof cashDrawerMovements.$inferSelect) => ({ ...serializeMovement(m), createdByName: nameOf(tx, m.createdBy) })),
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
  return db.transaction((tx) => {
    const drawer = tx.query.cashDrawers.findFirst({ where: eq(cashDrawers.id, id) }).sync();
    if (!drawer) throw Errors.notFound("Caixa");
    const summary = computeCashSummary(tx, drawer);

    const salesRows = tx
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
      .orderBy(desc(orderPayments.confirmedAt))
      .all();

    return {
      ...serializeDrawer(drawer),
      openedByName: nameOf(tx, drawer.openedBy),
      closedByName: nameOf(tx, drawer.closedBy),
      expectedCash: summary.expected,
      cashSalesTotal: summary.salesSum,
      movements: summary.movements.map((m: typeof cashDrawerMovements.$inferSelect) => ({ ...serializeMovement(m), createdByName: nameOf(tx, m.createdBy) })),
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
  return db.transaction((tx) => {
    if (findOpenDrawer(tx)) throw Errors.cashDrawerAlreadyOpen();
    const openedAt = new Date().toISOString();
    const drawer = tx
      .insert(cashDrawers)
      .values({
        openedBy: input.userId,
        openingAmount: round2(input.openingAmount),
        note: input.note ?? null,
        openedAt,
      })
      .returning()
      .get();
    logAction(tx, input.userId, "cash_drawer_opened", null, {
      drawerId: drawer.id,
      openingAmount: drawer.openingAmount,
    });
    enqueueEvent(tx, CASH_DRAWER_ROOM, "cash_drawer.opened", {
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
  return db.transaction((tx) => {
    const drawer = findOpenDrawer(tx);
    if (!drawer) throw Errors.cashDrawerNotOpen();

    if (input.type === "sangria") {
      const summary = computeCashSummary(tx, drawer);
      const over = round2(input.amount) - summary.expected;
      if (over > 0 && !moneyEq(input.amount, summary.expected)) {
        throw Errors.cashWithdrawalExceedsAvailable(summary.expected);
      }
    }

    const movement = tx
      .insert(cashDrawerMovements)
      .values({
        drawerId: drawer.id,
        type: input.type,
        amount: round2(input.amount),
        note: input.note ?? null,
        createdBy: input.userId,
      })
      .returning()
      .get();

    const action = input.type === "sangria" ? "cash_drawer_sangria" : "cash_drawer_suprimento";
    const eventType = input.type === "sangria" ? "cash_drawer.sangria" : "cash_drawer.suprimento";
    logAction(tx, input.userId, action, null, {
      drawerId: drawer.id,
      amount: movement.amount,
      note: movement.note,
    });
    enqueueEvent(tx, CASH_DRAWER_ROOM, eventType, {
      drawerId: drawer.id,
      amount: movement.amount,
    });
    return serializeMovement(movement);
  });
}

// ---------- POST /cash-drawer/close ----------
export async function closeCashDrawerUsecase(input: { userId: string; countedAmount: number }) {
  return db.transaction((tx) => {
    const drawer = findOpenDrawer(tx);
    if (!drawer) throw Errors.cashDrawerNotOpen();

    const summary = computeCashSummary(tx, drawer);
    const expected = summary.expected;
    const counted = round2(input.countedAmount);
    const difference = round2(counted - expected);
    const closedAt = new Date().toISOString();

    const closed = tx
      .update(cashDrawers)
      .set({
        status: "closed",
        closedAt,
        closedBy: input.userId,
        closingExpected: expected,
        closingCounted: counted,
        closingDifference: difference,
      })
      .where(eq(cashDrawers.id, drawer.id))
      .returning()
      .get();

    logAction(tx, input.userId, "cash_drawer_closed", null, {
      drawerId: drawer.id,
      openedBy: drawer.openedBy,
      openingAmount: drawer.openingAmount,
      expected,
      counted,
      difference,
    });
    enqueueEvent(tx, CASH_DRAWER_ROOM, "cash_drawer.closed", {
      drawerId: drawer.id,
      expected,
      counted,
      difference,
    });
    return { ...serializeDrawer(closed), cashSalesTotal: summary.salesSum };
  });
}
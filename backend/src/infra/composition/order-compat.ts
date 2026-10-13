/**
 * Compat layer da ONDA 2 — helpers transacionais legados do hub de pedidos.
 *
 * Estas funções receberiam um `tx` Drizzle cru dos use cases que AINDA não
 * migraram (product, purchase, payment, delivery, order-intake,
 * manager-delivery-status) e, por isso, moram em infra: importam
 * `drizzle-orm`, `db`/`schema` e o outbox. Os use cases migrados falam com os
 * ports (`session.*`); aqui as cópias/ wrappers mantêm as MESMAS assinaturas
 * e a MESMA semântica — inclusive a regra de "audit + outbox na mesma
 * transação da escrita de domínio".
 *
 * Regra para novos callers: prefira o port no `TenantSession`. Este arquivo só
 * existe para não queimar a migração de quem ainda tem um `tx`.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { db } from "../db/client.js";
import { orderItems, stockMovements, orders } from "../db/schema.js";
import { enqueueEvent } from "../realtime/outbox-dispatcher.js";
import { createPostgresTenantSession } from "../db/postgres-session.js";
import { round2 } from "../../domain/money.js";
import { Errors } from "../../domain/errors.js";
import {
  INVENTORY_ROOM,
  replayMovingAverage,
  type MovingAverage,
} from "../../application/stock/stock.usecases.js";

// Reexports para consumidores legados que importavam esses símbolos de
// stock.usecases (purchase.usecases). O caminho canônico agora é
// application/stock/stock.usecases.ts.
export { round2, INVENTORY_ROOM };
import { createAlert } from "../../application/alert/alert.usecases.js";
import { emitCustomerStageChanged } from "../../application/self-service/customer-stage.js";
import type { AlertRecord } from "../../application/ports/repositories.js";

// =====================================================================
// Estoque (cópias verbatim de application/stock/stock.usecases.ts)
// =====================================================================

// Saldo atual a partir do ledger — versão transacional (usada dentro de
// db.transaction, que no Node Postgres exige tudo awaited).
export async function stockBalance(tx: Tx, productId: string): Promise<number> {
  const rows = await tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId));
  return Number(rows[0]?.total ?? 0);
}

// Saldo de um produto — versão assíncrona, fora de transação.
export async function currentStock(productId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId));
  return rows[0]?.total ?? 0;
}

// Saldos de vários produtos em uma única query (usado na listagem).
export async function stockBalances(productIds: string[]): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: stockMovements.productId, total: sql<number>`sum(${stockMovements.quantityDelta})` })
    .from(stockMovements)
    .where(inArray(stockMovements.productId, productIds))
    .groupBy(stockMovements.productId);
  return new Map(rows.map((r) => [r.productId, r.total ?? 0]));
}

// Média móvel vigente — versão transacional. fallbackCost = cost_price manual
// do cadastro (usado antes da 1ª valoração). Ordena por `seq` para desempatar
// movimentos gravados no mesmo milissegundo (mesma ordem de sempre).
export async function computeMovingAverageTx(tx: Tx, productId: string, fallbackCost = 0): Promise<MovingAverage> {
  const rows = await tx
    .select({ quantityDelta: stockMovements.quantityDelta, unitCost: stockMovements.unitCost })
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId))
    .orderBy(stockMovements.createdAt, stockMovements.seq);
  return replayMovingAverage(rows, fallbackCost);
}

// Média móvel de vários produtos em uma query agrupada (listagem/valorização).
export async function averageCosts(productIds: string[]): Promise<Map<string, MovingAverage>> {
  const res = new Map<string, MovingAverage>();
  if (productIds.length === 0) return res;
  const rows = await db
    .select({
      productId: stockMovements.productId,
      quantityDelta: stockMovements.quantityDelta,
      unitCost: stockMovements.unitCost,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .where(inArray(stockMovements.productId, productIds))
    .orderBy(stockMovements.createdAt, stockMovements.seq);
  const groups = new Map<string, { quantityDelta: number; unitCost: number | null }[]>();
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

// Grava um movimento no ledger + evento `stock.movement` no room "inventory"
// na mesma transação. Retorna { row, balance } (saldo pós-movimento).
export async function applyStockMovementTx(
  tx: Tx,
  input: {
    productId: string;
    type: "sale" | "refund" | "purchase" | "adjustment";
    quantityDelta: number;
    unitCost?: number | null;
    purchaseItemId?: string | null;
    orderId?: string | null;
    orderItemId?: string | null;
    note?: string | null;
    createdBy: string;
  },
): Promise<{ row: typeof stockMovements.$inferSelect; balance: number }> {
  if (input.quantityDelta === 0) throw Errors.validationFailed({ field: "quantity", reason: "não pode ser zero" });
  const [row] = await tx
    .insert(stockMovements)
    .values({
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      unitCost: input.unitCost ?? null,
      purchaseItemId: input.purchaseItemId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .returning();

  const balance = await stockBalance(tx, input.productId);
  await enqueueEvent(tx, INVENTORY_ROOM, "stock.movement", {
    productId: input.productId,
    type: input.type,
    quantityDelta: input.quantityDelta,
    quantity: balance,
    unitCost: input.unitCost ?? null,
    orderId: input.orderId ?? null,
  });

  return { row: row!, balance };
}

// =====================================================================
// Total da comanda (cópia verbatim de application/order/order.usecases.ts)
// =====================================================================

// Total da comanda a partir do snapshot unit_price (nunca o preço atual do
// produto), arredondado pra 2 casas. Itens "cancelled" não contam (mesma
// regra do relatório de vendas). Roda dentro da transação do fechamento.
//
// Exportado para a camada de pagamento no gateway (application/payment): a
// cobrança tem que ser o MESMO total que o fechamento vai conferir, e duplicar
// a fórmula aqui seria o jeito de os dois divergirem num item cancelado.
export async function computeOrderTotal(tx: Tx, order: typeof orders.$inferSelect): Promise<number> {
  const rows = await tx
    .select({ unitPrice: orderItems.unitPrice, quantity: orderItems.quantity })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), notInArray(orderItems.status, ["cancelled"])));
  const sum = rows.reduce((acc, r) => acc + r.unitPrice * r.quantity, 0);
  return round2(sum + (order.deliveryFee ?? 0));
}

// =====================================================================
// Wrappers transacionais (delegam à application com a sessão do `tx`)
// =====================================================================

/**
 * Era a função de `alert.usecases.ts`: grava o alerta e publica o evento, na
 * MESMA transação do `tx` recebido. Delega para `createAlert(session, ...)`
 * montando a sessão Postgres sobre o mesmo `tx` — o fan-out de rooms e o
 * payload `alert.created` têm UMA fonte só.
 */
export async function createAlertTx(
  tx: Tx,
  input: Parameters<typeof createAlert>[1],
): Promise<AlertRecord> {
  return createAlert(createPostgresTenantSession(tx), input);
}

/**
 * Era a função de `self-service/customer-stage.ts`: deriva o stage do cliente
 * e enfileira `customer.stage_changed` no MESMO `tx`. Delega para
 * `emitCustomerStageChanged(session, ...)` com a sessão do `tx`.
 */
export async function emitCustomerStageChangedTx(tx: Tx, orderId: string) {
  return emitCustomerStageChanged(createPostgresTenantSession(tx), orderId);
}

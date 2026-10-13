// Ledger de estoque (migration 0016): o saldo de um produto é a soma dos
// deltas em `stock_movement` — nunca uma coluna cacheada (sem drift entre
// contador e histórico). Um único helper (`applyStockMovement`) grava o
// movimento E os eventos de realtime na mesma transação da escrita de
// domínio (regra do repo: audit log + outbox no mesmo commit).
//
// Tipos de movimento:
//   - sale        lançamento de item na comanda (-qty)
//   - refund      estorno: item removido / comanda cancelada (+qty)
//   - purchase    entrada de mercadoria manual (+qty)
//   - adjustment  ajuste/contagem manual (Δ sinalizado)
//
// Desenhado para evoluir a ficha técnica depois: deltas genéricos por
// produto; futuro próximo só adiciona ingredient/product_ingredient e
// passa a *calcular* esses deltas a partir da receita.
//
// ONDA 2: sem Drizzle/infra. Os helpers que precisavam de `tx`/`db` puro
// (`applyStockMovementTx`, `stockBalance`, `computeMovingAverageTx`, ...)
// moravam no compat transacional de `infra/composition/` e saíram junto da
// camada de pagamento — o último consumidor — na remoção do Pagar.me. Aqui
// ficam as funções puras (round2, replay da média móvel, constants) e a
// factory `createStockUsecases({ uow, tenant })`.
import { Errors } from "../../domain/errors.js";
import type { TenantSession, TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";

export const INVENTORY_ROOM = "inventory";

export type StockMovementType = "sale" | "refund" | "purchase" | "adjustment";

// ---------- Custo médio móvel (baseline 0001) ----------
// A média é um REPLAY do ledger sobre os eventos de valoração (quantity_delta >
// 0 com unit_cost): avg_n = (avg_prev*qty_prev + unit_cost*delta) / (qty_prev +
// delta). Vendas/refunds e ajuste negativo mudam quantidade, não a média;
// ajuste positivo sem custo só soma quantidade. Nunca coluna de estado.

export type MovingAverage = { avg: number; qty: number };

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Replay puro do ledger (linhas ordenadas por `createdAt, seq`). Exportado na
 * Onda 2: os adapters de estoque (`postgres-repositories`) e a compat
 * `order-compat` reutilizam ESTA fórmula — não existe uma segunda cópia.
 */
export function replayMovingAverage(
  rows: { quantityDelta: number; unitCost: number | null }[],
  fallbackCost: number,
): MovingAverage {
  let qty = 0;
  let avg = 0;
  let costed = false;
  for (const r of rows) {
    const d = r.quantityDelta;
    if (d > 0) {
      if (r.unitCost != null) {
        avg = qty > 0 ? (avg * qty + r.unitCost * d) / (qty + d) : r.unitCost;
        costed = true;
      }
      qty += d;
    } else {
      qty += d;
    }
  }
  if (qty < 0) qty = 0; // saldo negativo (over-consume) não valoriza: medida física
  return costed ? { avg: round2(avg), qty: round2(qty) } : { avg: round2(fallbackCost), qty: round2(qty) };
}

// Grava um movimento no ledger + evento `stock.movement` no room "inventory"
// na mesma transação da escrita de domínio (o `TenantSession` compartilha a
// transação com o repositório). Devolve o saldo PÓS-movimento.
//
// Era `applyStockMovementTx(tx, ...)`; a versão para um `tx` cru saiu junto
// do último consumidor (camada de pagamento, removida com o Pagar.me).
export async function applyStockMovement(
  session: TenantSession,
  input: {
    productId: string;
    type: StockMovementType;
    quantityDelta: number;
    unitCost?: number | null;
    purchaseItemId?: string | null;
    orderId?: string | null;
    orderItemId?: string | null;
    note?: string | null;
    createdBy: string;
  },
): Promise<{ balance: number }> {
  if (input.quantityDelta === 0) throw Errors.validationFailed({ field: "quantity", reason: "não pode ser zero" });

  const balance = await session.stock.recordMovement({
    productId: input.productId,
    type: input.type,
    quantityDelta: input.quantityDelta,
    unitCost: input.unitCost ?? undefined,
    purchaseItemId: input.purchaseItemId ?? null,
    orderId: input.orderId ?? null,
    orderItemId: input.orderItemId ?? null,
    note: input.note ?? null,
    actorId: input.createdBy,
  });

  await session.outbox.enqueue({
    room: INVENTORY_ROOM,
    type: "stock.movement",
    aggregateId: input.productId,
    payload: {
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      quantity: balance,
      unitCost: input.unitCost ?? null,
      orderId: input.orderId ?? null,
    },
  });

  return { balance };
}

// ---------- factory ----------

export interface StockUsecasesDeps {
  uow: TenantUnitOfWork;
  tenant: () => TenantContext;
}

export function createStockUsecases(deps: StockUsecasesDeps) {
  return {
    // ---------- GET /stock ----------
    async listStockUsecase(input: { lowOnly?: boolean; search?: string; limit: number; offset: number }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const { rows, total } = await session.stock.listTrackedProducts({
          search: input.search,
          limit: input.limit,
          offset: input.offset,
        });
        const balances = await session.stock.balances(rows.map((p) => p.productId));
        const averages = await session.stock.averageCosts(rows.map((p) => p.productId));

        const data = rows.map((p) => {
          const balance = balances.get(p.productId) ?? 0;
          const avg = averages.get(p.productId);
          return {
            productId: p.productId,
            name: p.name,
            categoryId: p.categoryId,
            categoryName: p.categoryName,
            unit: p.unit,
            unitCost: avg?.avg ?? p.costPrice, // custo médio móvel vigente (fallback: manual)
            manualCost: p.costPrice,
            quantity: balance,
            lowStockThreshold: p.lowStockThreshold,
            low: balance <= p.lowStockThreshold,
          };
        });

        return {
          data: input.lowOnly ? data.filter((d) => d.low) : data,
          total,
        };
      });
    },

    // ---------- GET /stock/movements ----------
    async getStockMovementsUsecase(input: { productId?: string; limit: number; offset: number }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const { rows, total } = await session.stock.listMovements({
          productId: input.productId,
          limit: input.limit,
          offset: input.offset,
        });
        return { data: rows, total };
      });
    },

    // ---------- POST /stock/:productId/movements (manual, manager) ----------
    async registerStockMovementUsecase(input: {
      productId: string;
      type: "purchase" | "adjustment";
      quantity: number; // purchase: positivo (+qty); adjustment: sinalizado (±)
      note?: string;
      userId: string;
    }) {
      if (input.type === "purchase" && input.quantity <= 0) {
        throw Errors.validationFailed({ field: "quantity", reason: "entrada deve ser maior que zero" });
      }
      if (input.type === "adjustment" && input.quantity === 0) {
        throw Errors.validationFailed({ field: "quantity", reason: "ajuste não pode ser zero" });
      }

      return deps.uow.run(deps.tenant(), async (session) => {
        const product = await session.catalog.findProductForOrdering(input.productId);
        if (!product) throw Errors.notFound("Produto");
        if (!product.trackStock) {
          throw Errors.validationFailed({
            field: "productId",
            reason: "produto não controla estoque (habilite no cadastro)",
          });
        }

        await applyStockMovement(session, {
          productId: input.productId,
          type: input.type,
          quantityDelta: input.quantity,
          note: input.note ?? null,
          createdBy: input.userId,
        });
        await session.audit.record({
          actorId: input.userId,
          action: "stock_movement_manual",
          orderId: null,
          details: {
            productId: input.productId,
            type: input.type,
            quantityDelta: input.quantity,
            note: input.note ?? null,
          },
        });

        return { productId: input.productId, type: input.type, quantityDelta: input.quantity };
      });
    },
  };
}

export type StockUsecases = ReturnType<typeof createStockUsecases>;

/**
 * Relatório de Entregas: como a operação de delivery está indo.
 *
 * Deriva das MESMAS comandas fechadas do relatório de vendas e filtra as que
 * têm entrega — receita e número de entrega têm que bater, ou o gerente não
 * sabe qual dos dois está errado.
 *
 * Três medidas, porque cada uma pega um problema diferente:
 *
 * - **entregas** — volume (a operação está ocupada?);
 * - **no prazo** — `delivered_at` contra `estimated_minutes` (a previsão que o
 *   cliente viu está honrada?);
 * - **tempo médio** — do `dispatched_at` ao `delivered_at` (o atraso está na
 *   rua ou na cozinha?).
 *
 * `failed` conta nas entregas mas NÃO como sucesso: uma entrega com problema é
 * o que o gerente precisa ver. Por isso o relatório separa `delivered` de
 * `failed` em vez de oferecer um "taxa de sucesso" — um número só esconde qual
 * dos dois está caindo.
 */
import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { deliveries, orders, orderItems, users } from "../infra/db/schema.js";
import { round2 } from "../domain/money.js";
import { Errors } from "../domain/errors.js";
import { getCache } from "../infra/cache/index.js";
import { dayEnd, dayStart, isValidTz } from "./cash-flow/day-bounds.js";
import { isValidReportDate } from "./report-overview.usecases.js";

const cache = getCache();

export async function deliveriesReportUsecase(input: { from?: string; to?: string; tz?: string }) {
  const tz = input.tz;
  const now = new Date();
  const to = input.to ?? now.toISOString().slice(0, 10);
  const from = input.from ?? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);

  if (!isValidReportDate(from) || !isValidReportDate(to))
    throw Errors.validationFailed("from/to devem ser YYYY-MM-DD");
  if (from > to) throw Errors.validationFailed("`from` não pode ser depois de `to`.");
  if (!isValidTz(tz)) throw Errors.validationFailed("tz deve ser um offset como -03:00.");

  const key = `reports:deliveries:${JSON.stringify({ from, to, tz: tz ?? null })}`;
  const cached = cache.get<DeliveriesReport>(key);
  if (cached) return cached;

  // Filtra pela COMANDA fechada (mesma base do relatório de vendas) e traz a
  // entrega junto por innerJoin — assim só entram comandas que de fato têm
  // delivery, sem precisar filtrar as de mesa depois.
  const rows = await db
    .select({
      orderId: orders.id,
      status: deliveries.status,
      courierId: deliveries.courierId,
      courierName: users.name,
      deliveryFee: orders.deliveryFee,
      estimatedMinutes: deliveries.estimatedMinutes,
      dispatchedAt: deliveries.dispatchedAt,
      deliveredAt: deliveries.deliveredAt,
    })
    .from(deliveries)
    .innerJoin(orders, eq(orders.id, deliveries.orderId))
    .leftJoin(users, eq(users.id, deliveries.courierId))
    .where(
      and(
        eq(orders.status, "closed"),
        gte(orders.closedAt!, dayStart(from, tz)),
        lte(orders.closedAt!, dayEnd(to, tz)),
      ),
    );

  // Receita de delivery: mesma conta do relatório de vendas (itens no snapshot
  // + taxa), para que os dois relatórios não discordem sobre o mesmo pedido.
  const totalsByOrder = new Map<string, number>();
  if (rows.length > 0) {
    const itemRows = await db
      .select({
        orderId: orderItems.orderId,
        total: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .where(
        and(
          inArray(orderItems.orderId, rows.map((r) => r.orderId)),
          notInArray(orderItems.status, ["cancelled"]),
        ),
      )
      .groupBy(orderItems.orderId);
    for (const r of itemRows) totalsByOrder.set(r.orderId, r.total);
  }

  let delivered = 0;
  let failed = 0;
  let cancelled = 0;
  let pending = 0;
  let onTime = 0;
  let totalMinutes = 0;
  let timedCount = 0;
  let revenue = 0;
  let feeRevenue = 0;

  const byCourier = new Map<string, { id: string; name: string; deliveries: number; onTime: number; minutes: number; timed: number }>();

  for (const r of rows) {
    const courierKey = r.courierId ?? "none";
    const cur = byCourier.get(courierKey) ?? {
      id: r.courierId ?? "",
      name: r.courierName ?? "Não atribuído",
      deliveries: 0,
      onTime: 0,
      minutes: 0,
      timed: 0,
    };
    cur.deliveries += 1;
    byCourier.set(courierKey, cur);

    revenue += (totalsByOrder.get(r.orderId) ?? 0) + (r.deliveryFee ?? 0);
    feeRevenue += r.deliveryFee ?? 0;

    if (r.status === "delivered") {
      delivered += 1;
      const dispatched = r.dispatchedAt ? Date.parse(r.dispatchedAt) : NaN;
      const done = r.deliveredAt ? Date.parse(r.deliveredAt) : NaN;
      // Só mede o que tem as duas marcas: `delivered` lançado pelo gerente sem
      // dispatch registrado (correção pelo balcão) não tem de onde sair, e
      // entrar com zero aqui afundaria a média de todo mundo.
      if (Number.isFinite(dispatched) && Number.isFinite(done) && done >= dispatched) {
        const minutes = Math.round((done - dispatched) / 60_000);
        totalMinutes += minutes;
        timedCount += 1;
        cur.minutes += minutes;
        cur.timed += 1;
        // No prazo = dentro da previsão que o cliente viu. Sem
        // `estimated_minutes` não há como julgar, então não conta como atraso:
        // loja que não configurou a faixa não pode ser penalizada por isso.
        if (r.estimatedMinutes && minutes <= r.estimatedMinutes) {
          onTime += 1;
          cur.onTime += 1;
        }
      }
    } else if (r.status === "failed") {
      failed += 1;
    } else if (r.status === "cancelled") {
      cancelled += 1;
    } else {
      pending += 1;
    }
  }

  const result: DeliveriesReport = {
    from,
    to,
    summary: {
      deliveries: rows.length,
      delivered,
      failed,
      cancelled,
      pending,
      onTime,
      onTimeRate: delivered > 0 ? round2((onTime / delivered) * 100) : 0,
      avgMinutes: timedCount > 0 ? round2(totalMinutes / timedCount) : 0,
      revenue: round2(revenue),
      deliveryFee: round2(feeRevenue),
    },
    byCourier: [...byCourier.values()]
      .map((c) => ({
        id: c.id,
        name: c.name,
        deliveries: c.deliveries,
        onTime: c.onTime,
        avgMinutes: c.timed > 0 ? round2(c.minutes / c.timed) : 0,
      }))
      .sort((a, b) => b.deliveries - a.deliveries),
  };

  cache.set(key, result, { ttl: 300 });
  return result;
}

export type DeliveriesReport = {
  from: string;
  to: string;
  summary: {
    deliveries: number;
    delivered: number;
    failed: number;
    cancelled: number;
    pending: number;
    onTime: number;
    onTimeRate: number;
    avgMinutes: number;
    revenue: number;
    deliveryFee: number;
  };
  byCourier: Array<{ id: string; name: string; deliveries: number; onTime: number; avgMinutes: number }>;
};
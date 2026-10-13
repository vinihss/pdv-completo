/**
 * `GET /reports/overview` — visão geral: vendas agrupadas por período, para o
 * gráfico do gerente.
 *
 * É uma "fatia" deliberada do relatório de vendas (`sales-report.usecase.ts`),
 * não uma refatoração dele: o relatório de pedidos quer detalhe (produto,
 * margem, forma de pagamento, paginação) e este quer uma linha por dia. A REGRA
 * DE VENDA, porém, é obrigatoriamente a mesma — comandas fechadas, total pela
 * soma dos itens no snapshot `unit_price` mais a taxa de entrega. Se os dois
 * endpoints discordarem, o gerente vê um total na visão geral e outro no
 * relatório de pedidos e perde a confiança nos dois. Por isso a regra está
 * documentada duas vezes, aqui e lá.
 *
 * As leituras (comandas fechadas no intervalo + itens agregados por comanda)
 * rodam na janela `uow.run` via `session.reports`; o cache
 * `reports:overview:*` é efeito via port `TenantCache` (set pós-commit, TTL
 * 300). Os helpers de bucket (`bucketKeyFor`/`bucketLabel`/`fillBuckets`)
 * moram em `shared/report-buckets.ts` — customer e o relatório de entregas
 * também os consomem.
 */
import { round2 } from "../../../domain/money.js";
import { Errors } from "../../../domain/errors.js";
import { dayEnd, dayStart, isValidTz, parseTzOffset } from "../../cash-flow/day-bounds.js";
import type { ReportDependencies } from "../ports/report-dependencies.js";
import { bucketKeyFor, bucketLabel, fillBuckets, isValidReportDate } from "../shared/report-buckets.js";

export type OverviewReportInput = {
  from?: string;
  to?: string;
  groupBy?: "hour" | "day" | "week" | "month";
  tz?: string;
};

export type OverviewResult = {
  from: string;
  to: string;
  groupBy: "hour" | "day" | "week" | "month";
  series: Array<{ bucket: string; label: string; total: number; orderCount: number }>;
  totals: { totalSales: number; orderCount: number; avgTicket: number };
};

export class OverviewReportUseCase {
  constructor(private readonly deps: ReportDependencies) {}

  async execute(input: OverviewReportInput) {
    const groupBy = input.groupBy ?? "day";
    const tz = input.tz;

    // Sem período explícito, 30 dias — o mesmo default do relatório de vendas,
    // para os dois abertos sem filtro mostrarem a mesma janela.
    const now = new Date();
    const to = input.to ?? now.toISOString().slice(0, 10);
    const from =
      input.from ?? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);

    if (!isValidReportDate(from) || !isValidReportDate(to)) throw Errors.validationFailed("from/to devem ser YYYY-MM-DD");
    if (from > to) throw Errors.validationFailed("`from` não pode ser depois de `to`.");
    if (!isValidTz(tz)) throw Errors.validationFailed("tz deve ser um offset como -03:00.");

    const key = `reports:overview:${JSON.stringify({ from, to, groupBy, tz: tz ?? null })}`;
    const cached = await this.deps.cache.get<OverviewResult>(key);
    if (cached) return cached;

    const result = await this.deps.uow.run(this.deps.tenant(), async (session) => {
      // `dayStart`/`dayEnd` convertem "YYYY-MM-DD" no intervalo UTC do dia LOCAL da
      // loja: é o que impede a venda das 22h de cair no dia anterior no gráfico.
      // As bordas resolvidas vão ao adapter (`listClosedOrdersBetween`).
      const orderRows = await session.reports.listClosedOrdersBetween(dayStart(from, tz), dayEnd(to, tz));

      // Itens agregados por comanda no próprio SQL: uma linha por comanda em vez
      // de uma por item (o detalhe do item não é usado aqui).
      const itemsByOrder = new Map<string, number>();
      if (orderRows.length > 0) {
        const itemRows = await session.reports.listItemsTotalByOrder(orderRows.map((o) => o.id));
        for (const r of itemRows) itemsByOrder.set(r.orderId, r.total);
      }

      const offsetMinutes = parseTzOffset(tz);
      const totals = new Map<string, { total: number; orderCount: number }>();
      for (const o of orderRows) {
        const at = Date.parse(o.closedAt ?? "");
        if (Number.isNaN(at)) continue;
        const bucket = bucketKeyFor(at, groupBy, offsetMinutes);
        const cur = totals.get(bucket) ?? { total: 0, orderCount: 0 };
        cur.total += (itemsByOrder.get(o.id) ?? 0) + (o.deliveryFee ?? 0);
        cur.orderCount += 1;
        totals.set(bucket, cur);
      }

      const series = fillBuckets(from, to, groupBy, tz).map((bucket) => {
        const t = totals.get(bucket) ?? { total: 0, orderCount: 0 };
        return { bucket, label: bucketLabel(bucket, groupBy), total: round2(t.total), orderCount: t.orderCount };
      });

      // Somado pela série, não pelos pedidos: assim o total bate com o que o
      // frontend soma dos pontos desenhados, mesmo que um bucket do intervalo
      // caia em fuso diferente (virada de horário de verão).
      const totalSales = round2(series.reduce((s, p) => s + p.total, 0));
      const orderCount = series.reduce((s, p) => s + p.orderCount, 0);

      const result: OverviewResult = {
        from,
        to,
        groupBy,
        series,
        totals: {
          totalSales,
          orderCount,
          avgTicket: orderCount > 0 ? round2(totalSales / orderCount) : 0,
        },
      };
      return result;
    });

    await this.deps.cache.set(key, result, { ttl: 300 });
    return result;
  }
}

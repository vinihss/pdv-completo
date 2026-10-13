/**
 * `GET /customers/:id/summary` — consumo do cliente por dia, para o gráfico
 * da tela de detalhe.
 *
 * REGRA DE VENDA deliberadamente igual à da visão geral
 * (`report/usecases/overview-report.usecase.ts`): só comandas FECHADAS, total pela soma dos
 * itens no snapshot `unit_price` mais a taxa de entrega. Se os dois gráficos
 * discordarem sobre as mesmas comandas, o gerente perde a confiança nos dois —
 * e um cliente cujo consumo some do gráfico enquanto aparece no relatório é
 * exatamente esse caso.
 *
 * `order_payment` NÃO entra: a regra do pedido fechado funciona para todos os
 * canais porque não depende de como o dinheiro entrou.
 *
 * Dia LOCAL da loja (`tz`, como na visão geral): às 22h de São Paulo a venda é
 * do dia de hoje, não do dia seguinte em UTC. `bucketKeyFor`/`fillBuckets` já
 * sabe disso — e o comentário lá em L13-26 explica por que o agrupamento é
 * feito em JS (`closed_at` é TEXT ISO, `date_trunc` exigiria cast por linha).
 * Não reabrir essa decisão aqui.
 *
 * SEM CACHE (ao contrário de `/reports/overview`): aquele é um número da loja
 * inteira, caro de calcular e estável por minutos; este é de UMA pessoa e muda
 * toda vez que ela paga. Cache aqui mostraria um valor que já foi desmentido
 * por um pagamento, e a invalidação não teria onde morar.
 */
import { Errors } from "../../../domain/errors.js";
import { round2 } from "../../../domain/money.js";
import { bucketKeyFor, bucketLabel, fillBuckets } from "../../report/shared/report-buckets.js";
import { dayEnd, dayStart, isValidTz, parseTzOffset } from "../../cash-flow/day-bounds.js";
import type { CustomerDependencies } from "../ports/customer-dependencies.js";
import { normalizeDays } from "../shared/customer-helpers.js";

export type CustomerSummaryInput = {
  days?: number;
  tz?: string;
};

export class CustomerSummaryUseCase {
  constructor(private readonly deps: CustomerDependencies) {}

  async execute(customerId: string, input: CustomerSummaryInput) {
    return this.deps.uow.run(this.deps.tenant(), async (session) => {
      const customer = await session.customers.findById(customerId);
      if (!customer) throw Errors.notFound("Cliente");
      if (!isValidTz(input.tz)) throw Errors.validationFailed("tz deve ser um offset como -03:00.");

      const days = normalizeDays(input.days);
      const tz = input.tz!;
      const offsetMinutes = parseTzOffset(tz);

      // "Hoje" no relógio da LOJA, não do servidor: às 21h de São Paulo o UTC ainda
      // está no dia anterior, e o gráfico terminaria ontem.
      const to = bucketKeyFor(Date.now(), "day", offsetMinutes);
      // `days` pontos, contando o dia de hoje — 30 dias devolve 30 entradas, não 31.
      const from = bucketKeyFor(Date.parse(dayStart(to, tz)) - (days - 1) * 86_400_000, "day", offsetMinutes);

      const orderRows = await session.orders.listClosedByCustomerBetween(
        customerId,
        dayStart(from, tz),
        dayEnd(to, tz),
      );

      const agg = await session.orders.aggregateItemsByOrders(orderRows.map((o) => o.id));

      const perDay = new Map<string, { total: number; orderCount: number }>();
      for (const o of orderRows) {
        const at = Date.parse(o.closedAt ?? "");
        if (Number.isNaN(at)) continue;
        const bucket = bucketKeyFor(at, "day", offsetMinutes);
        const cur = perDay.get(bucket) ?? { total: 0, orderCount: 0 };
        cur.total += (agg.get(o.id)?.total ?? 0) + (o.deliveryFee ?? 0);
        cur.orderCount += 1;
        perDay.set(bucket, cur);
      }

      // `fillBuckets` devolve a sequência COMPLETA, e dia sem consumo vem com zero
      // de propósito: o frontend desenha os pontos que recebe, então um dia ausente
      // vira um buraco na linha (ou pior: uma reta ligando o dia anterior ao
      // próximo, sugerindo consumo que não houve).
      const series = fillBuckets(from, to, "day", tz).map((bucket) => {
        const t = perDay.get(bucket) ?? { total: 0, orderCount: 0 };
        return {
          day: bucket,
          // Label pronto em pt-BR ("01/10") pelo mesmo helper da visão geral: o
          // frontend consome direto e nunca formata data no cliente.
          label: bucketLabel(bucket, "day"),
          total: round2(t.total),
          orderCount: t.orderCount,
        };
      });

      // Somado pela série (e não pelos pedidos) para o total bater com o que o
      // frontend soma dos pontos desenhados.
      return {
        from,
        to,
        series,
        totals: {
          total: round2(series.reduce((s, p) => s + p.total, 0)),
          orderCount: series.reduce((s, p) => s + p.orderCount, 0),
        },
      };
    });
  }
}

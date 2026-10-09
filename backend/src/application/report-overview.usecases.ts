/**
 * Visão geral: vendas agrupadas por período, para o gráfico do gerente.
 *
 * É uma purposely "fatia" do `salesReportUsecase` (report.usecases.ts), não uma
 * refatoração dele: o relatório de pedidos quer detalhe (produto, margem, forma
 * de pagamento, paginação) e este quer uma linha por dia. A REGRA DE VENDA,
 * porém, é obrigatoriamente a mesma — comandas fechadas, total pela soma dos
 * itens no snapshot `unit_price` mais a taxa de entrega. Se os dois
 *Endpoints discordarem, o gerente vê um total na visão geral e outro no
 * relatório de pedidos e perde a confiança nos dois. Por isso a regra está
 * documentada duas vezes, aqui e lá.
 *
 * Duas decisões que não são óbvias:
 *
 * 1. **Bucket em JS, não em SQL.** `orders.closed_at` é TEXT (ISO), então
 *    `date_trunc` exigiria cast por linha e, pior, `AT TIME ZONE` com tz
 *    parametrizado. Agregar em JS sobre as comandas já filtradas é mais
 *    simples de auditar contra o `salesReportUsecase` e tem o mesmo custo:
 *    duas queries no total (comandas + itens agrupados por comanda), sem N+1.
 *    O volume é o de um restaurante (milhares de comandas por 30 dias).
 *
 * 2. **Dias sem venda vêm com zero.** Um gráfico com buracos é pior que
 *    gráfico nenhum: o frontend receberia apenas os dias que tiveram venda e
 *    desenharia uma reta que suggests movimento num dia que não teve. Por isso
 *    `fillBuckets` monta a sequência completa de `from` a `to`.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { orders, orderItems } from "../infra/db/schema.js";
import { round2 } from "../domain/money.js";
import { Errors } from "../domain/errors.js";
import { tenantCache } from "../infra/cache/index.js";
import { dayEnd, dayStart, isValidTz, parseTzOffset } from "./cash-flow/day-bounds.js";

// Cache particionado por schema: relatórios são sempre do tenant corrente.
const cache = tenantCache;

const MONTH_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidReportDate(input?: string): boolean {
  if (input === undefined) return true;
  if (!DATE_RE.test(input)) return false;
  const d = new Date(`${input}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === input;
}

/**
 * Instante UTC → milissegundos do RELÓGIO LOCAL da loja.
 *
 * `parseTzOffset("-03:00")` devolve -180, e no Brasil local = UTC - 3h, ou
 * seja `utc + offset`. Somar e não subtrair é a diferença entre o dia certo e o
 * dia anterior na hora de fechar o caixa — e o sinal invertido paca
 * exatamente nas horas em que o restaurante vende (à noite).
 */
function toLocalMs(instantMs: number, offsetMinutes: number): number {
  return instantMs + offsetMinutes * 60_000;
}

/** Chave `YYYY-MM-DD` a partir de ms já no relógio local (offset zero). */
function localDayKey(localMs: number): string {
  return new Date(localMs).toISOString().slice(0, 10);
}

/**
 * Segunda-feira da semana ISO de um dia (ms no relógio local).
 * `getUTCDay` 0 = domingo, então a distância até a segunda é `(d + 6) % 7`.
 */
function isoWeekStartMs(localDayStartMs: number): number {
  const dow = new Date(localDayStartMs).getUTCDay();
  return localDayStartMs - ((dow + 6) % 7) * 86_400_000;
}

/** Meia-noite local do dia que contém `localMs`. */
function localDayStartOf(localMs: number): number {
  const d = new Date(localMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function bucketKeyFor(
  instantMs: number,
  groupBy: "hour" | "day" | "week" | "month",
  offsetMinutes: number,
): string {
  const localMs = toLocalMs(instantMs, offsetMinutes);
  if (groupBy === "hour") return `${new Date(localMs).toISOString().slice(0, 13)}:00`;
  if (groupBy === "month") {
    const d = new Date(localMs);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const dayStartMs = localDayStartOf(localMs);
  if (groupBy === "week") return localDayKey(isoWeekStartMs(dayStartMs));
  return localDayKey(dayStartMs);
}

export function bucketLabel(key: string, groupBy: "hour" | "day" | "week" | "month"): string {
  if (groupBy === "hour") return `${key.slice(11, 13)}h`;
  const [y, m, d] = key.split("-").map(Number);
  if (groupBy === "month") return `${MONTH_SHORT[(m || 1) - 1]}/${y}`;
  const dd = String(d ?? 1).padStart(2, "0");
  const mm = String(m ?? 1).padStart(2, "0");
  return groupBy === "week" ? `${dd}/${mm}–` : `${dd}/${mm}`;
}

/**
 * Sequência completa de buckets de `from` a `to`.
 *
 * Para `day`/`week`/`month` anda em dias no relógio local — o passo é um dia
 * inteiro e o offset é fixo, então andar em UTC daria a mesma sequência. Para
 * `hour` o passo é de uma hora e o offset muda a MEIA-NOITE, então o caminho
 * é pelos instantes UTC reais de `dayStart` a `dayEnd` (com o tz aplicado),
 * rotulados no relógio local.
 */
export function fillBuckets(
  from: string,
  to: string,
  groupBy: "hour" | "day" | "week" | "month",
  tz?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };

  if (groupBy === "hour") {
    const startMs = Date.parse(dayStart(from, tz));
    const endMs = Date.parse(dayEnd(to, tz));
    const offsetMinutes = parseTzOffset(tz);
    for (let ms = startMs; ms <= endMs; ms += 3_600_000) {
      push(`${new Date(toLocalMs(ms, offsetMinutes)).toISOString().slice(0, 13)}:00`);
    }
    return out;
  }

  const startLocal = Date.parse(dayStart(from, tz));
  const endLocal = Date.parse(dayStart(to, tz));

  if (groupBy === "month") {
    let cursor = new Date(localDayStartOf(startLocal));
    const last = new Date(localDayStartOf(endLocal));
    while (cursor <= last) {
      push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return out;
  }

  const stepMs = groupBy === "week" ? 7 * 86_400_000 : 86_400_000;
  // Em `week` a primeira chave é a segunda-feira da semana do `from`: o gráfico
  // começa pelo bucket que CONTÉM o primeiro dia do período, mesmo que ele
  // comece antes. Sem isso, a venda da terça cairia num bucket que a série nem
  // mostra.
  let cursor = groupBy === "week" ? isoWeekStartMs(localDayStartOf(startLocal)) : localDayStartOf(startLocal);
  while (cursor <= localDayStartOf(endLocal)) {
    push(localDayKey(cursor));
    cursor += stepMs;
  }
  return out;
}

export async function overviewReportUsecase(input: {
  from?: string;
  to?: string;
  groupBy?: "hour" | "day" | "week" | "month";
  tz?: string;
}) {
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
  const cached = cache.get<OverviewResult>(key);
  if (cached) return cached;

  // `dayStart`/`dayEnd` convertem "YYYY-MM-DD" no intervalo UTC do dia LOCAL da
  // loja: é o que impede a venda das 22h de cair no dia anterior no gráfico.
  const conditions = [
    eq(orders.status, "closed"),
    gte(orders.closedAt!, dayStart(from, tz)),
    lte(orders.closedAt!, dayEnd(to, tz)),
  ];

  const orderRows = await db
    .select({
      id: orders.id,
      closedAt: orders.closedAt,
      deliveryFee: orders.deliveryFee,
    })
    .from(orders)
    .where(and(...conditions));

  // Itens agregados por comanda no próprio SQL: uma linha por comanda em vez
  // de uma por item (o detalhe do item não é usado aqui).
  const itemsByOrder = new Map<string, number>();
  if (orderRows.length > 0) {
    const itemRows = await db
      .select({
        orderId: orderItems.orderId,
        total: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .where(
        and(
          inArray(orderItems.orderId, orderRows.map((o) => o.id)),
          // Cancelados não entram no total — mesma regra do relatório de vendas
          // e de `computeOrderTotal`.
          sql`${orderItems.status} <> 'cancelled'`,
        ),
      )
      .groupBy(orderItems.orderId);
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
  cache.set(key, result, { ttl: 300 });
  return result;
}

export type OverviewResult = {
  from: string;
  to: string;
  groupBy: "hour" | "day" | "week" | "month";
  series: Array<{ bucket: string; label: string; total: number; orderCount: number }>;
  totals: { totalSales: number; orderCount: number; avgTicket: number };
};

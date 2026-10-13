/**
 * Buckets dos relatórios — agrupamento por período no relógio LOCAL da loja.
 *
 * Duas decisões que não são óbvias (valem para a visão geral, para o gráfico do
 * cliente e para qualquer relatório novo que agrupe por período):
 *
 * 1. **Bucket em JS, não em SQL.** `orders.closed_at` é TEXT (ISO), então
 *    `date_trunc` exigiria cast por linha e, pior, `AT TIME ZONE` com tz
 *    parametrizado. Agregar em JS sobre as comandas já filtradas é mais
 *    simples de auditar e tem o mesmo custo: duas queries no total (comandas +
 *    itens agrupados por comanda), sem N+1. O volume é o de um restaurante
 *    (milhares de comandas por 30 dias).
 *
 * 2. **Dias sem venda vêm com zero.** Um gráfico com buracos é pior que
 *    gráfico nenhum: o frontend receberia apenas os dias que tiveram venda e
 *    desenharia uma reta que sugere movimento num dia que não teve. Por isso
 *    `fillBuckets` monta a sequência completa de `from` a `to`.
 */
import { dayEnd, dayStart, parseTzOffset } from "../../cash-flow/day-bounds.js";

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
 * dia anterior na hora de fechar o caixa — e o sinal invertido peca
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

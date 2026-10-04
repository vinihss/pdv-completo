import { and, asc, count, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../infra/db/client.js";
import { customers, customerAddresses, orders, orderItems, restaurantTables } from "../infra/db/schema.js";
import { Errors } from "../domain/errors.js";
import { logAction } from "../infra/audit-log.js";
import { normalizeAccents } from "../domain/text.js";
import { normalizeCpf } from "../domain/cpf.js";
import { round2 } from "../domain/money.js";
import { photoUrl } from "./user.usecases.js";
import { getStorage, isSafeFilename, storageFilename } from "../infra/storage/index.js";
import { bucketKeyFor, bucketLabel, fillBuckets, isValidReportDate } from "./report-overview.usecases.js";
import { dayEnd, dayStart, isValidTz, parseTzOffset } from "./cash-flow/day-bounds.js";

const storage = getStorage();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? "";
  if (!trimmed) return null;
  if (!EMAIL_RE.test(trimmed)) throw Errors.validationFailed({ field: "email" });
  return trimmed.toLowerCase();
}

function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 8 || digits.length > 15) throw Errors.validationFailed({ field: "phone" });
  return digits;
}

// Observação é texto livre: o limite é o que o banco aceita. Só o vazio é
// normalizado para null, para "limpar o campo" e "nunca preencher" não
// virarem dois estados diferentes na mesma coluna.
function normalizeNotes(notes: string | null | undefined): string | null {
  const trimmed = (notes ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * Fonte única do shape de cliente, usada pela lista, pelo detalhe, pelo create
 * e pelo update. `cpf`/`notes`/`photoPath` (migration 0008) entram aqui em vez
 * de só no detalhe de propósito: são os mesmos papéis (gerente/caixa) em todas
 * essas rotas, e um campo que aparece no PATCH mas não na lista faria o
 * frontend decidir "devo reler o GET?" depois de salvar. A busca do garçom
 * (`searchCustomersUsecase`) NÃO usa este serialize — é a superfície mínima
 * do balcão e não muda.
 */
function serialize(c: typeof customers.$inferSelect, addressCount = 0) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone ?? null,
    email: c.email ?? null,
    // CPF cru (11 dígitos, sem máscara) e `photoPath` já no caminho público —
    // quem consome a API não monta `/uploads/...` por conta própria.
    cpf: c.cpf ?? null,
    notes: c.notes ?? null,
    photoPath: photoUrl(c.photoPath, "customer"),
    active: c.active,
    addressCount,
    createdAt: c.createdAt,
  };
}

// Busca ignorando acentos (unaccent no banco + termo normalizado no app) e
// case (ILIKE). Telefone e email entram na busca — o balcão costuma achar o
// cliente por qualquer um dos três.
function searchCondition(term: string): SQL {
  const t = `%${term}%`;
  return sql`(
    unaccent(${customers.name}) ILIKE unaccent(${t})
    OR ${customers.phone} ILIKE ${t}
    OR unaccent(${customers.email}) ILIKE unaccent(${t})
  )`;
}

// Busca leve do garçom (abrir comanda com cliente): só ativos, sem email —
// a manutenção completa é a rota paginada, restrita a gerente/caixa.
export async function searchCustomersUsecase(search?: string) {
  const conditions: SQL[] = [eq(customers.active, true)];
  if (search?.trim()) conditions.push(searchCondition(normalizeAccents(search.trim())));
  const rows = await db.query.customers.findMany({
    where: and(...conditions),
    orderBy: (c, { asc }) => asc(c.name),
    limit: 20,
  });
  return rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null }));
}

export async function listCustomersUsecase(input: { search?: string; active?: boolean; limit: number; offset: number }) {
  const conditions: SQL[] = [];
  if (input.active !== undefined) conditions.push(eq(customers.active, input.active));
  if (input.search?.trim()) conditions.push(searchCondition(normalizeAccents(input.search.trim())));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db.query.customers.findMany({
    where,
    orderBy: (c, { asc }) => asc(c.name),
    limit: input.limit,
    offset: input.offset,
  });
  const totalRow = await db.select({ count: sql<number>`count(*)` }).from(customers).where(where);

  // Contagem de endereços em lote (evita N+1 na listagem).
  //
  // TODO: o GROUP BY aqui é GLOBAL — ele agrupa a tabela `customer_address`
  // inteira, sem o mesmo `where` da página, e o mapa é inteiro mesmo quando a
  // listagem devolve 20 linhas. Não é N+1 (é uma query só), mas é O(base).
  // Corrigir é mexer no contrato do dadoauxiliar: ou um LEFT JOIN com
  // `count(...) over ()` na própria consulta da página, ou um `where
  // customer_id in (<ids da página>)`. Fica de fora desta mudança.
  const counts = await db
    .select({ customerId: customerAddresses.customerId, count: sql<number>`count(*)` })
    .from(customerAddresses)
    .groupBy(customerAddresses.customerId);
  const countMap = new Map(counts.map((r) => [r.customerId, Number(r.count)]));

  return { data: rows.map((c) => serialize(c, countMap.get(c.id) ?? 0)), total: Number(totalRow[0]?.count ?? rows.length) };
}

/**
 * Total e contagem de itens por comanda, numa query só.
 *
 * Mesmo cálculo do `computeOrderTotal` (`order.usecases.ts`) e da visão geral
 * (`report-overview.usecases.ts`): soma `unit_price × quantity` do SNAPSHOT do
 * lançamento, ignorando `cancelled`, mais a taxa de entrega da comanda. Item
 * cancelado nunca entra, e o preço é o do momento da venda, não o de hoje.
 *
 * `itemCount` soma `quantity` (não linhas): "12 itens" numa comanda com 3
 * linhas de 4 unidades tem que dizer 12, que é o que o cliente consumiu.
 */
async function itemsAggregateByOrder(orderIds: string[]) {
  const map = new Map<string, { total: number; itemCount: number }>();
  if (orderIds.length === 0) return map;
  const rows = await db
    .select({
      orderId: orderItems.orderId,
      total: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)`,
      itemCount: sql<number>`coalesce(sum(${orderItems.quantity}), 0)`,
    })
    .from(orderItems)
    .where(
      and(
        inArray(orderItems.orderId, orderIds),
        sql`${orderItems.status} <> 'cancelled'`,
      )
    )
    .groupBy(orderItems.orderId);
  for (const r of rows) map.set(r.orderId, { total: Number(r.total), itemCount: Number(r.itemCount) });
  return map;
}

export async function getCustomerDetailUsecase(id: string) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!customer) throw Errors.notFound("Cliente");
  const addresses = await db.query.customerAddresses.findMany({
    where: eq(customerAddresses.customerId, customer.id),
    orderBy: (a, { asc }) => asc(a.createdAt),
  });

  // Comandas abertas do cliente: o alerta "este cliente tem uma comanda em
  // aberto" é a informação que o caixa precisa ANTES de cobrar/conferir, e
  // ela não pode depender de uma segunda consulta do frontend.
  //
  // Batch em 2 queries (mesma régua de `listOrdersUsecase`, ver
  // docs/12-n-plus-one-list-orders.md): as comandas vêm com `tableNumber` já
  // por LEFT JOIN e os totais por uma agregação agrupada por comanda. A mais
  // antiga primeiro, que é a que está há mais tempo esperando pagamento.
  const openRows = await db
    .select({
      id: orders.id,
      status: orders.status,
      openedAt: orders.openedAt,
      tabLabel: orders.tabLabel,
      deliveryFee: orders.deliveryFee,
      tableNumber: restaurantTables.number,
    })
    .from(orders)
    .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
    .where(and(eq(orders.customerId, customer.id), eq(orders.status, "open")))
    .orderBy(asc(orders.openedAt));
  const openAgg = await itemsAggregateByOrder(openRows.map((o) => o.id));

  return {
    ...serialize(customer),
    addresses: addresses.map((a) => ({
      id: a.id,
      label: a.label ?? null,
      cep: a.cep ?? null,
      street: a.street,
      number: a.number,
      complement: a.complement ?? null,
      neighborhood: a.neighborhood,
      city: a.city,
      // `state` (UF) entrou em 0006 e a rota pública de endereço já devolvia;
      // aqui faltava, e o cadastro manual (rota do gerente) não tinha o campo
      // no schema. Cliente salvo pelo balcão ficava sem UF enquanto o mesmo
      // cliente salvo no checkout tinha.
      state: a.state ?? null,
      reference: a.reference ?? null,
      isDefault: a.isDefault,
    })),
    openOrders: openRows.map((o) => ({
      id: o.id,
      tableNumber: o.tableNumber ?? null,
      tabLabel: o.tabLabel ?? null,
      openedAt: o.openedAt,
      total: round2((openAgg.get(o.id)?.total ?? 0) + (o.deliveryFee ?? 0)),
      status: o.status,
    })),
  };
}

async function assertEmailAvailable(email: string | null | undefined, exceptCustomerId?: string) {
  if (!email) return;
  const clash = await db.query.customers.findFirst({ where: eq(customers.email, email) });
  if (clash && clash.id !== exceptCustomerId) throw Errors.validationFailed({ field: "email", reason: "email já cadastrado" });
}

/**
 * CPF único entre clientes — mesma forma do email: `400 validation_failed` com
 * `{ field: "cpf" }`, e o `uq_customer_cpf` (migration 0008) como segunda
 * linha de defesa para a corrida em que dois requests passam pelo check juntos.
 */
async function assertCpfAvailable(cpf: string | null | undefined, exceptCustomerId?: string) {
  if (!cpf) return;
  const clash = await db.query.customers.findFirst({ where: eq(customers.cpf, cpf) });
  if (clash && clash.id !== exceptCustomerId) throw Errors.validationFailed({ field: "cpf", reason: "CPF já cadastrado" });
}

export async function createCustomerUsecase(
  input: { name: string; phone?: string | null; email?: string | null; cpf?: string | null; notes?: string | null },
  actorId: string
) {
  const email = normalizeEmail(input.email);
  await assertEmailAvailable(email);
  const cpf = normalizeCpf(input.cpf);
  await assertCpfAvailable(cpf);
  const phone = normalizePhone(input.phone);
  const notes = normalizeNotes(input.notes);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(customers).values({ name: input.name, phone, email, cpf, notes }).returning();
    await logAction(tx, actorId, "customer_created", null, { customerId: row.id, name: row.name });
    return row;
  });
  return serialize(created);
}

export async function updateCustomerUsecase(
  id: string,
  input: { name?: string; phone?: string | null; email?: string | null; cpf?: string | null; notes?: string | null; active?: boolean },
  actorId: string
) {
  const existing = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!existing) throw Errors.notFound("Cliente");

  const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
  if (input.email !== undefined) await assertEmailAvailable(email, id);
  const cpf = input.cpf !== undefined ? normalizeCpf(input.cpf) : undefined;
  if (input.cpf !== undefined) await assertCpfAvailable(cpf, id);
  const phone = input.phone !== undefined ? normalizePhone(input.phone) : undefined;
  const notes = input.notes !== undefined ? normalizeNotes(input.notes) : undefined;

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(customers)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(cpf !== undefined ? { cpf } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(eq(customers.id, id))
      .returning();
    await logAction(tx, actorId, input.active === false ? "customer_deactivated" : input.active === true ? "customer_reactivated" : "customer_updated", null, {
      customerId: id,
      name: row.name,
    });
    return row;
  });
  return serialize(updated);
}

// ---------- Foto (upload em disco, caminho gravado em customer.photo_path) ----------
//
// Cópia do desenho de `user.usecases.ts` (foto de equipe), que é o mesmo das
// fotos de produto e do logo da loja: nome de arquivo GERADO pelo app a partir
// do id (o nome enviado pelo cliente nunca vira caminho em disco), o nome
// gravado no banco é só o basename, arquivo antigo removido quando a extensão
// muda, e o `logAction` na mesma transação do UPDATE — se a auditoria falhasse
// fora dela, ninguém saberia que a foto mudou.

export async function saveCustomerPhotoUsecase(id: string, input: { buffer: Buffer; ext: string }, actorId: string) {
  const existing = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!existing) throw Errors.notFound("Cliente");

  const filename = `${id}.${input.ext}`;
  if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "photo" });
  await storage.put("customer", filename, input.buffer);

  // Remove a foto antiga quando o cliente trocou a extensão do arquivo
  const previous = storageFilename(existing.photoPath);
  if (previous && previous !== filename) await storage.remove("customer", previous);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(customers).set({ photoPath: filename }).where(eq(customers.id, id)).returning();
    await logAction(tx, actorId, "customer_photo_changed", null, { customerId: id });
    return row;
  });
  return serialize(updated);
}

export async function clearCustomerPhotoUsecase(id: string, actorId: string) {
  const existing = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!existing) throw Errors.notFound("Cliente");
  const previous = storageFilename(existing.photoPath);
  if (previous) await storage.remove("customer", previous);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(customers).set({ photoPath: null }).where(eq(customers.id, id)).returning();
    await logAction(tx, actorId, "customer_photo_removed", null, { customerId: id });
    return row;
  });
  return serialize(updated);
}

// ---------- Histórico de pedidos do cliente ----------

/**
 * Histórico paginado de comandas do cliente (o `idx_order_customer` já existe
 * para isso), mais recente primeiro.
 *
 * `closed_at DESC NULLS LAST` é explícito de propósito: comanda aberta não tem
 * `closed_at`, e no `DESC` do Postgres os NULLs vêm PRIMEIRO — a comanda em
 * aberto que o cliente tem agora apareceria no topo de um histórico de visitas
 * pasadas. Com `NULLS LAST` ela fica no fim, que é onde "ainda não terminou"
 * pertence.
 *
 * Batch em 2 queries de dados (mais a contagem, como em `listOrdersUsecase`):
 * comandas com `tableNumber` por LEFT JOIN e totais/contagem por uma agregação
 * agrupada por comanda. Nada aqui é por comanda — o N+1 do doc 12 não volta.
 */
export async function listCustomerOrdersUsecase(
  customerId: string,
  input: { limit: number; offset: number; from?: string; to?: string; tz?: string }
) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!customer) throw Errors.notFound("Cliente");

  // Filtro de dia é OPCIONAL e é o que faz o drill-down do gráfico funcionar:
  // filtrar no cliente sobre a página 1 de 20Some dia esconde as comandas mais
  // antigas daquele dia, e o gerente conclui que elas não existiram. Filtro no
  // servidor é o único jeito de a página seguinte continuar completa.
  const conditions: SQL[] = [eq(orders.customerId, customerId)];
  if (input.from !== undefined || input.to !== undefined) {
    if (!isValidReportDate(input.from) || !isValidReportDate(input.to)) {
      throw Errors.validationFailed("from/to devem ser YYYY-MM-DD");
    }
    if (input.from && input.to && input.from > input.to) {
      throw Errors.validationFailed("`from` não pode ser depois de `to`.");
    }
    if (!isValidTz(input.tz)) throw Errors.validationFailed("tz deve ser um offset como -03:00.");
    // Dia LOCAL da loja, como em todo relatório (às 22h de SP a venda é do dia
    // de hoje, não do dia seguinte em UTC).
    if (input.from) conditions.push(gte(orders.closedAt!, dayStart(input.from, input.tz)));
    if (input.to) conditions.push(lte(orders.closedAt!, dayEnd(input.to, input.tz)));
  }

  const rows = await db
    .select({
      id: orders.id,
      status: orders.status,
      openedAt: orders.openedAt,
      closedAt: orders.closedAt,
      tabLabel: orders.tabLabel,
      paymentMethod: orders.paymentMethod,
      deliveryFee: orders.deliveryFee,
      tableNumber: restaurantTables.number,
    })
    .from(orders)
    .leftJoin(restaurantTables, eq(restaurantTables.id, orders.tableId))
    .where(and(...conditions))
    .orderBy(sql`${orders.closedAt} DESC NULLS LAST, ${orders.openedAt} DESC`)
    .limit(input.limit)
    .offset(input.offset);

  const agg = await itemsAggregateByOrder(rows.map((o) => o.id));

  const data = rows.map((o) => ({
    id: o.id,
    status: o.status,
    openedAt: o.openedAt,
    closedAt: o.closedAt,
    tableNumber: o.tableNumber ?? null,
    tabLabel: o.tabLabel ?? null,
    paymentMethod: o.paymentMethod,
    total: round2((agg.get(o.id)?.total ?? 0) + (o.deliveryFee ?? 0)),
    itemCount: agg.get(o.id)?.itemCount ?? 0,
  }));

  const totalRow = await db.select({ count: count() }).from(orders).where(and(...conditions));
  return { data, total: totalRow[0]?.count ?? data.length };
}

// ---------- Série de consumo (gráfico da tela de detalhe) ----------

const DEFAULT_SUMMARY_DAYS = 30;
const MAX_SUMMARY_DAYS = 365;

// Janela do gráfico. O clamp é aqui (e não na rota) porque o valor também vem
// de link/URL: 0 dias ou 40000 dias dariam uma série inútil (ou um relatório
// varrendo a base) em vez de um erro, e quem decide o teto é o domínio.
function normalizeDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return DEFAULT_SUMMARY_DAYS;
  return Math.min(MAX_SUMMARY_DAYS, Math.max(1, Math.trunc(days)));
}

/**
 * Consumo do cliente por dia, para o gráfico da tela de detalhe.
 *
 * REGRA DE VENDA deliberadamente igual à da visão geral
 * (`report-overview.usecases.ts`): só comandas FECHADAS, total pela soma dos
 * itens no snapshot `unit_price` mais a taxa de entrega. Se os dois gráficos
 * discordarem sobre as mesmas comandas, o gerente perde a confiança nos dois —
 * e um cliente cujo consumo some do gráfico enquanto aparece no relatório é
 * exatamente esse caso.
 *
 * `order_payment` NÃO entra: o iFood grava o pagamento em
 * `order.ifood_payments` (JSON), então uma comanda iFood somada por
 * `order_payment` apareceria como zero no gráfico. A regra do pedido fechado
 * funciona para todos os canais porque não depende de como o dinheiro entrou.
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
export async function customerSummaryUsecase(customerId: string, input: { days?: number; tz?: string }) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!customer) throw Errors.notFound("Cliente");
  if (!isValidTz(input.tz)) throw Errors.validationFailed("tz deve ser um offset como -03:00.");

  const days = normalizeDays(input.days);
  const tz = input.tz;
  const offsetMinutes = parseTzOffset(tz);

  // "Hoje" no relógio da LOJA, não do servidor: às 21h de São Paulo o UTC ainda
  // está no dia anterior, e o gráfico terminaria ontem.
  const to = bucketKeyFor(Date.now(), "day", offsetMinutes);
  // `days` pontos, contando o dia de hoje — 30 dias devolve 30 entradas, não 31.
  const from = bucketKeyFor(Date.parse(dayStart(to, tz)) - (days - 1) * 86_400_000, "day", offsetMinutes);

  const orderRows = await db
    .select({ id: orders.id, closedAt: orders.closedAt, deliveryFee: orders.deliveryFee })
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        eq(orders.status, "closed"),
        gte(orders.closedAt!, dayStart(from, tz)),
        lte(orders.closedAt!, dayEnd(to, tz)),
      )
    );

  const agg = await itemsAggregateByOrder(orderRows.map((o) => o.id));

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
  // de propósito: o frontend desenha os pontos que recebe, então um dia
  // ausente vira um buraco na linha (ou pior: uma reta ligando o dia anterior
  // ao próximo, sugerindo consumo que não houve).
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
}

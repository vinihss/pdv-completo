/**
 * Clientes — ONDA 3C da refatoração arquitetural.
 *
 * Factory pura (`createCustomerUsecases`): nenhuma importação de
 * infra/Drizzle. Persistência via `session.customers`/`session.customerAddresses`/
 * `session.orders` na janela `uow.run`, audit via `session.audit` (MESMA
 * transação da escrita de domínio) e arquivos via port `FileStorage`.
 *
 * Semântica preservada do módulo original:
 *   - `searchCustomersUsecase`: busca leve do balcão — só ativos, sem email,
 *     ordem alfabética, LIMIT 20 (`session.customers.searchLight`);
 *   - `listCustomersUsecase`: busca `unaccent ILIKE` + filtro `active` +
 *     contagem de endereços em LOTE (o adapter faz `WHERE customer_id IN (...)` —
 *     corrige o TODO do original, que agrupava a tabela INTEIRA por página);
 *   - `getCustomerDetailUsecase`: endereços (criados primeiro) + comandas
 *     abertas (mais antigas primeiro, com `tableNumber` por LEFT JOIN e totais
 *     por agregação agrupada — sem N+1, régua do doc 12);
 *   - create/update: unicidade de email/CPF com 400 (o `uq_customer_email`/
 *     `uq_customer_cpf` do banco é a segunda linha de defesa), normalizações de
 *     domínio e audit na mesma transação;
 *   - foto: nome = `<id>.<ext>` (o nome enviado nunca vira caminho),
 *     arquivo antigo removido quando a extensão muda, audit na mesma transação;
 *   - histórico paginado: `closed_at DESC NULLS LAST` (comanda aberta fica no
 *     fim), filtro de dia opcional com bordas do dia LOCAL da loja, batch em 2
 *     queries (comandas + agregação por comanda);
 *   - série de consumo: REGRA DE VENDA igual à visão geral (só fechadas, soma
 *     do snapshot + frete), agrupada em JS por dia local, SEM cache, e o total
 *     somado pela série (não pelos pedidos).
 *
 * APROXIMAÇÃO DE JANELA (mesma da Onda 2/3A): as leituras que ficavam fora do
 * tx (`db.query.customers`, `db.query.customerAddresses`, agregações) agora
 * acontecem na janela `uow.run` — resultado observável idêntico. O storage
 * (efeito externo, sem transação) continua fora do UoW.
 */
import { Errors } from "../domain/errors.js";
import { normalizeCpf } from "../domain/cpf.js";
import { round2 } from "../domain/money.js";
import { bucketKeyFor, bucketLabel, fillBuckets, isValidReportDate } from "./report-overview.usecases.js";
import { dayEnd, dayStart, isValidTz, parseTzOffset } from "./cash-flow/day-bounds.js";
import type { TenantUnitOfWork, TenantSession } from "./ports/unit-of-work.js";
import type { TenantContext } from "./ports/tenant-context.js";
import type { FileStorage } from "./ports/effects.js";
import type { CustomerRecord } from "./ports/repositories.js";

// ---------- helpers puros (eram infra/storage) ----------
//
// `storageAssetPath`/`isSafeFilename`/`storageFilename` são funções PURAS de
// `infra/storage` (sem I/O). Definidas aqui para a application não importar a
// camada de armazenamento — o `FileStorage` port (put/remove) é a única seam
// de I/O. `photoUrl` replica o helper de `user.usecases.ts` (mesma família de
// foto de equipe). Mantêm a MESMA lógica.

/** `/uploads/<kind>/<filename>` — mesmo formato de `storageAssetPath`. */
const UPLOADS_PREFIX = "/uploads";
type PhotoKind = "product" | "logo" | "customer" | "user";
function photoUrl(photoPath: string | null | undefined, kind: PhotoKind): string | null {
  return photoPath ? `${UPLOADS_PREFIX}/${kind}/${photoPath}` : null;
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  return FILENAME_RE.test(filename);
}

/** Normaliza o que está no banco para o nome de arquivo (só o basename). */
function storageFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
}

// ---------- normalizações de domínio (mesmas do módulo original) ----------

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
function serialize(c: CustomerRecord, addressCount = 0) {
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

async function assertEmailAvailable(
  session: TenantSession,
  email: string | null | undefined,
  exceptCustomerId?: string,
) {
  if (!email) return;
  const clash = await session.customers.findByEmail(email);
  if (clash && clash.id !== exceptCustomerId) throw Errors.validationFailed({ field: "email", reason: "email já cadastrado" });
}

/**
 * CPF único entre clientes — mesma forma do email: `400 validation_failed` com
 * `{ field: "cpf" }`, e o `uq_customer_cpf` (migration 0008) como segunda
 * linha de defesa para a corrida em que dois requests passam pelo check juntos.
 */
async function assertCpfAvailable(session: TenantSession, cpf: string | null | undefined, exceptCustomerId?: string) {
  if (!cpf) return;
  const clash = await session.customers.findByCpf(cpf);
  if (clash && clash.id !== exceptCustomerId) throw Errors.validationFailed({ field: "cpf", reason: "CPF já cadastrado" });
}

export interface CustomerUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Upload/remoção da foto do cliente em disco. */
  storage: FileStorage;
}

export function createCustomerUsecases(deps: CustomerUsecasesDeps) {
  return {
    // Busca leve do garçom (abrir comanda com cliente): só ativos, sem email —
    // a manutenção completa é a rota paginada, restrita a gerente/caixa.
    async searchCustomersUsecase(search?: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.customers.searchLight(search);
        return rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null }));
      });
    },

    async listCustomersUsecase(input: { search?: string; active?: boolean; limit: number; offset: number }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const page = await session.customers.list(input);

        // Contagem de endereços em lote (evita N+1 na listagem). O adapter
        // filtra por `customer_id IN (ids da página)` — uma query só, sem
        // varrer a tabela inteira (corrige o TODO do original).
        const counts = await session.customers.countAddressesByCustomer(page.data.map((c) => c.id));

        return {
          data: page.data.map((c) => serialize(c, counts.get(c.id) ?? 0)),
          total: page.total,
        };
      });
    },

    async getCustomerDetailUsecase(id: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findById(id);
        if (!customer) throw Errors.notFound("Cliente");
        const addresses = await session.customerAddresses.listByCustomer(customer.id);
        // Criados primeiro (mesma ordenação do `orderBy createdAt ASC` do
        // original) — ordenado aqui porque `listByCustomer` é compartilhado
        // com o self-service e não ordena.
        addresses.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

        // Comandas abertas do cliente: o alerta "este cliente tem uma comanda em
        // aberto" é a informação que o caixa precisa ANTES de cobrar/conferir, e
        // ela não pode depender de uma segunda consulta do frontend.
        //
        // Batch em 2 queries (mesma régua de `listOrdersUsecase`, ver
        // docs/12-n-plus-one-list-orders.md): as comandas vêm com `tableNumber` já
        // por LEFT JOIN e os totais por uma agregação agrupada por comanda. A mais
        // antiga primeiro, que é a que está há mais tempo esperando pagamento.
        const openRows = await session.orders.listOpenByCustomer(customer.id);
        const openAgg = await session.orders.aggregateItemsByOrders(openRows.map((o) => o.id));

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
      });
    },

    async createCustomerUsecase(
      input: { name: string; phone?: string | null; email?: string | null; cpf?: string | null; notes?: string | null },
      actorId: string,
    ) {
      const email = normalizeEmail(input.email);
      const cpf = normalizeCpf(input.cpf);
      const phone = normalizePhone(input.phone);
      const notes = normalizeNotes(input.notes);

      return deps.uow.run(deps.tenant(), async (session) => {
        await assertEmailAvailable(session, email);
        await assertCpfAvailable(session, cpf);
        const created = await session.customers.save({ name: input.name, phone, email, cpf, notes });
        await session.audit.record({
          actorId,
          action: "customer_created",
          orderId: null,
          details: { customerId: created.id, name: created.name },
        });
        return serialize(created);
      });
    },

    async updateCustomerUsecase(
      id: string,
      input: { name?: string; phone?: string | null; email?: string | null; cpf?: string | null; notes?: string | null; active?: boolean },
      actorId: string,
    ) {
      const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
      const cpf = input.cpf !== undefined ? normalizeCpf(input.cpf) : undefined;
      const phone = input.phone !== undefined ? normalizePhone(input.phone) : undefined;
      const notes = input.notes !== undefined ? normalizeNotes(input.notes) : undefined;

      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.customers.findById(id);
        if (!existing) throw Errors.notFound("Cliente");

        if (input.email !== undefined) await assertEmailAvailable(session, email, id);
        if (input.cpf !== undefined) await assertCpfAvailable(session, cpf, id);

        const updated = await session.customers.save({
          id,
          name: existing.name,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(cpf !== undefined ? { cpf } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        });
        await session.audit.record({
          actorId,
          action:
            input.active === false
              ? "customer_deactivated"
              : input.active === true
                ? "customer_reactivated"
                : "customer_updated",
          orderId: null,
          details: { customerId: id, name: updated.name },
        });
        return serialize(updated);
      });
    },

    // ---------- Foto (upload em disco, caminho gravado em customer.photo_path) ----------
    //
    // Cópia do desenho de `user.usecases.ts` (foto de equipe), que é o mesmo das
    // fotos de produto e do logo da loja: nome de arquivo GERADO pelo app a partir
    // do id (o nome enviado pelo cliente nunca vira caminho em disco), o nome
    // gravado no banco é só o basename, arquivo antigo removido quando a extensão
    // muda, e o `logAction` na mesma transação do UPDATE — se a auditoria falhasse
    // fora dela, ninguém saberia que a foto mudou.

    async saveCustomerPhotoUsecase(id: string, input: { buffer: Buffer; ext: string }, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.customers.findById(id);
        if (!existing) throw Errors.notFound("Cliente");

        const filename = `${id}.${input.ext}`;
        if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "photo" });
        await deps.storage.put("customer", filename, input.buffer);

        // Remove a foto antiga quando o cliente trocou a extensão do arquivo
        const previous = storageFilename(existing.photoPath);
        if (previous && previous !== filename) await deps.storage.remove("customer", previous);

        const updated = await session.customers.save({ id, name: existing.name, photoPath: filename });
        await session.audit.record({
          actorId,
          action: "customer_photo_changed",
          orderId: null,
          details: { customerId: id },
        });
        return serialize(updated);
      });
    },

    async clearCustomerPhotoUsecase(id: string, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const existing = await session.customers.findById(id);
        if (!existing) throw Errors.notFound("Cliente");
        const previous = storageFilename(existing.photoPath);
        if (previous) await deps.storage.remove("customer", previous);

        const updated = await session.customers.save({ id, name: existing.name, photoPath: null });
        await session.audit.record({
          actorId,
          action: "customer_photo_removed",
          orderId: null,
          details: { customerId: id },
        });
        return serialize(updated);
      });
    },

    // ---------- Histórico de pedidos do cliente ----------

    /**
     * Histórico paginado de comandas do cliente (o `idx_order_customer` já existe
     * para isso), mais recente primeiro.
     *
     * `closed_at DESC NULLS LAST` é explícito de propósito: comanda aberta não tem
     * `closed_at`, e no `DESC` do Postgres os NULLs vêm PRIMEIRO — a comanda em
     * aberto que o cliente tem agora apareceria no topo de um histórico de visitas
     * passadas. Com `NULLS LAST` ela fica no fim, que é onde "ainda não terminou"
     * pertence.
     *
     * Batch em 2 queries de dados (mais a contagem, como em `listOrdersUsecase`):
     * comandas com `tableNumber` por LEFT JOIN e totais/contagem por uma agregação
     * agrupada por comanda. Nada aqui é por comanda — o N+1 do doc 12 não volta.
     */
    async listCustomerOrdersUsecase(
      customerId: string,
      input: { limit: number; offset: number; from?: string; to?: string; tz?: string },
    ) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findById(customerId);
        if (!customer) throw Errors.notFound("Cliente");

        // Filtro de dia é OPCIONAL e é o que faz o drill-down do gráfico funcionar:
        // filtrar no cliente sobre a página 1 de 20Some dia esconde as comandas mais
        // antigas daquele dia, e o gerente conclui que elas não existiram. Filtro no
        // servidor é o único jeito de a página seguinte continuar completa.
        if (input.from !== undefined || input.to !== undefined) {
          if (!isValidReportDate(input.from) || !isValidReportDate(input.to)) {
            throw Errors.validationFailed("from/to devem ser YYYY-MM-DD");
          }
          if (input.from && input.to && input.from > input.to) {
            throw Errors.validationFailed("`from` não pode ser depois de `to`.");
          }
          if (!isValidTz(input.tz)) throw Errors.validationFailed("tz deve ser um offset como -03:00.");
        }
        // Dia LOCAL da loja, como em todo relatório (às 22h de SP a venda é do dia
        // de hoje, não do dia seguinte em UTC) — as bordas vão RESOLVIDAS ao port.
        // `tz` ausente = UTC (default de `dayStart`/`dayEnd`), como no original.
        const from = input.from ? dayStart(input.from, input.tz) : undefined;
        const to = input.to ? dayEnd(input.to, input.tz) : undefined;

        const page = await session.orders.listHistoryByCustomer(customerId, {
          limit: input.limit,
          offset: input.offset,
          from,
          to,
        });
        const agg = await session.orders.aggregateItemsByOrders(page.data.map((o) => o.id));

        const data = page.data.map((o) => ({
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

        return { data, total: page.total };
      });
    },

    // ---------- Série de consumo (gráfico da tela de detalhe) ----------

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
     * `order_payment` NÃO entra: a regra do pedido fechado funciona para todos
     * os canais porque não depende de como o dinheiro entrou.
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
    async customerSummaryUsecase(customerId: string, input: { days?: number; tz?: string }) {
      return deps.uow.run(deps.tenant(), async (session) => {
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
      });
    },
  };
}

export type CustomerUsecases = ReturnType<typeof createCustomerUsecases>;

// ---------- constantes e helpers do summary (mesmos do módulo original) ----------

const DEFAULT_SUMMARY_DAYS = 30;
const MAX_SUMMARY_DAYS = 365;

// Janela do gráfico. O clamp é aqui (e não na rota) porque o valor também vem
// de link/URL: 0 dias ou 40000 dias dariam uma série inútil (ou um relatório
// varrendo a base) em vez de um erro, e quem decide o teto é o domínio.
function normalizeDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return DEFAULT_SUMMARY_DAYS;
  return Math.min(MAX_SUMMARY_DAYS, Math.max(1, Math.trunc(days)));
}
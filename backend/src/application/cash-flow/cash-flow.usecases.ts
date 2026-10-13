// Fluxo de caixa / gaveta / sangria / suprimento — FACTORY (ports + Unit-of-Work).
//
// Este arquivo é uma factory pura (`createCashFlowUsecases(deps)`): nenhuma
// importação de infra/integrations/config nem de Drizzle. Toda persistência
// passa pelos ports do `TenantSession` (a gaveta em `session.cashFlow`, o
// singleton `store_settings` em `session.storeSettings`, usuário em
// `session.users`) e `audit`/`outbox` saem na MESMA transação do UoW. Quem liga
// os adapters concretos é a composition root
// (`src/infra/composition/default-usecases.ts`).
//
// NOTA IMPORTANTE sobre async (mesma regra do order.usecases.ts): dentro de
// `uow.run(tenant, work)` o repositório é SEMPRE uma Promise — todo acesso ao
// `session` precisa de `await`. Sem ele, o INSERT/UPDATE pode ser emitido
// depois do COMMIT e a escrita se perder em silêncio. O `throw` continua sendo
// o mecanismo de rollback (o AppError de domínio aborta a transação e propaga).
//
// APROXIMAÇÃO DE JANELA (documentada de propósito): as leituras que antes
// rodavam "fora do tx" (listagem de caixas, por exemplo) agora rodam DENTRO do
// `uow.run` — uma única janela transacional por use case. Sob READ COMMITTED o
// resultado é o mesmo; o ganho é um caminho só para ler e escrever.
//
// Timestamps de abertura e fechamento do caixa continuam gravados como ISO 8601
// UTC explícito para que a comparação com `order_payment.confirmed_at` (que
// também é ISO) seja lexicograficamente consistente — o padrão
// `(current_timestamp)` do SQL não seria (espaço vs "T" no separador).
//
// APROXIMAÇÃO DE APRESENTAÇÃO: o rótulo da comanda de um estorno
// (`ref_order_id`) era resolvido por um LEFT JOIN com `restaurant_table`; aqui
// a MESMA informação sai de `orders.findRow` + `catalog.findTable` (o rótulo
// "Mesa N"/tabLabel é montado no use case, como manda a regra dos ports).
import { Errors } from "../../domain/errors.js";
import { round2, moneyEq } from "../../domain/money.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { TenantSession, TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { CashDrawerRecord, CashMovementRecord } from "../ports/repositories.js";

const CASH_DRAWER_ROOM = "cash-drawer";

function serializeDrawer(d: CashDrawerRecord) {
  // Parse closingDenominations de JSON string para array, com fallback para []
  let closingDenominations: Array<{ denomination: number; quantity: number }> = [];
  if (d.closingDenominations) {
    try {
      const parsed = JSON.parse(d.closingDenominations);
      if (Array.isArray(parsed)) {
        closingDenominations = parsed;
      }
    } catch {
      // JSON inválido, manter array vazio
    }
  }

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
    closingNote: d.closingNote,
    closingDenominations,
    closingJustification: d.closingJustification,
    closingApprovedBy: d.closingApprovedBy,
  };
}

function serializeMovement(m: CashMovementRecord) {
  return {
    id: m.id,
    type: m.type,
    amount: m.amount,
    note: m.note,
    refOrderId: m.refOrderId,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    category: m.category,
  };
}

// Rótulo de exibição da comanda de um estorno (ref_order_id): rótulo da
// comanda, nº da mesa ou fallback pro id. Mesma régua do join original.
async function orderLabelOf(session: TenantSession, orderId: string): Promise<string> {
  const order = await session.orders.findRow(orderId);
  if (!order) return orderId;
  const table = order.tableId ? await session.catalog.findTable(order.tableId) : null;
  return order.tabLabel ?? (table?.number != null ? `Mesa ${table.number}` : orderId);
}

async function nameOf(session: TenantSession, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await session.users.findById(userId);
  return u?.name ?? null;
}

async function serializeMovements(session: TenantSession, movements: CashMovementRecord[]) {
  // Sequencial de propósito: dentro de `uow.run` todas as queries compartilham
  // UM único client do node-postgres, e `Promise.all` ali é query concorrente
  // no mesmo client (pg serializa por baixo e emite DeprecationWarning "client
  // is already executing a query", removido no pg@9). Não custa tempo: o
  // paralelismo não existia.
  const out: Array<
    ReturnType<typeof serializeMovement> & { createdByName: string | null; refOrderLabel: string | null }
  > = [];
  for (const m of movements) {
    out.push({
      ...serializeMovement(m),
      createdByName: await nameOf(session, m.createdBy),
      refOrderLabel: m.refOrderId ? await orderLabelOf(session, m.refOrderId) : null,
    });
  }
  return out;
}

// Esperado = fundo inicial + vendas em dinheiro confirmadas no período
// + suprimentos − sangrias. Calculado sempre dentro da transação da operação
// para não divergir do estado persistido em paralelo.
async function computeCashSummary(session: TenantSession, drawer: CashDrawerRecord) {
  const upper = drawer.closedAt ?? new Date().toISOString();
  const sales = await session.cashFlow.listCashPaymentsBetween(drawer.openedAt, upper);
  const movements = await session.cashFlow.listMovements(drawer.id);
  const salesSum = round2(sales.reduce((acc, s) => acc + s.amount, 0));
  const expected = round2(
    drawer.openingAmount + salesSum + movements.reduce((acc, m) => acc + (m.type === "sangria" ? -m.amount : m.amount), 0)
  );
  return { expected, sales, salesSum, movements };
}

// Categorias permitidas para movimentos de caixa (Bloco 6)
const ALLOWED_MOVEMENT_CATEGORIES = [
  "sangria_operacional",
  "suprimento_troco",
  "pagamento_fornecedor",
  "ajuste_inventario",
  "outros",
] as const;

export type MovementCategory = (typeof ALLOWED_MOVEMENT_CATEGORIES)[number];

/**
 * Deps da factory: Unit-of-Work + tenant resolvido POR CHAMADA. Só ports:
 * audit/outbox saem do `TenantSession` (mesma transação) e não há efeito
 * externo (impressão/cache) neste fluxo.
 */
export interface CashFlowUsecasesDeps {
  uow: TenantUnitOfWork;
  tenant: () => TenantContext;
}

export function createCashFlowUsecases(deps: CashFlowUsecasesDeps) {
  return {
    // ---------- GET /cash-drawer/current ----------
    async getCurrentDrawerUsecase() {
      return deps.uow.run(deps.tenant(), async (session) => {
        const open = await session.cashFlow.findOpen();
        if (!open) return null;
        const summary = await computeCashSummary(session, open);
        // Sequencial: um client por transação (ver serializeMovements).
        const openedByName = await nameOf(session, open.openedBy);
        const movements = await serializeMovements(session, summary.movements);
        return {
          ...serializeDrawer(open),
          openedByName,
          expectedCash: summary.expected,
          cashSalesTotal: summary.salesSum,
          cashSalesCount: summary.sales.length,
          movements,
        };
      });
    },

    // ---------- GET /cash-drawer ----------
    async listCashDrawersUsecase(input: { limit: number; offset: number }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.cashFlow.list(input);
        const data = rows.map(serializeDrawer);
        return { data };
      });
    },

    // ---------- GET /cash-drawer/:id ----------
    async getCashDrawerDetailUsecase(id: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const drawer = await session.cashFlow.findById(id);
        if (!drawer) throw Errors.notFound("Caixa");
        const summary = await computeCashSummary(session, drawer);

        // Mesma janela do summary: até o fechamento (ou agora, se aberta).
        const upper = drawer.closedAt ?? new Date().toISOString();
        const salesRows = await session.cashFlow.listCashSalesBetween(drawer.openedAt, upper);

        // Sequencial: um client por transação (ver serializeMovements).
        const openedByName = await nameOf(session, drawer.openedBy);
        const closedByName = await nameOf(session, drawer.closedBy);
        const movements = await serializeMovements(session, summary.movements);

        return {
          ...serializeDrawer(drawer),
          openedByName,
          closedByName,
          expectedCash: summary.expected,
          cashSalesTotal: summary.salesSum,
          movements,
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
    },

    // ---------- POST /cash-drawer/open ----------
    async openCashDrawerUsecase(input: { userId: string; openingAmount: number; note?: string }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // O índice único parcial uq_cash_drawer_single_open (status='open') é a
        // garantia final de "uma sessão por vez": se duas requisições passarem
        // pela checagem, o INSERT de uma delas viola o índice e ela recebe o
        // mesmo erro de domínio em vez de abrir uma segunda gaveta. A checagem +
        // tratamento da violação ficam no adapter (`session.cashFlow.open`).
        const drawer = await session.cashFlow.open({
          actorId: input.userId,
          openingAmount: input.openingAmount,
          note: input.note ?? null,
          openedAt: new Date().toISOString(),
        });
        await session.audit.record({
          actorId: input.userId,
          action: "cash_drawer_opened",
          orderId: null,
          details: {
            drawerId: drawer.id,
            openingAmount: drawer.openingAmount,
          },
        });
        await session.outbox.enqueue({
          room: CASH_DRAWER_ROOM,
          type: "cash_drawer.opened",
          aggregateId: drawer.id,
          payload: {
            drawerId: drawer.id,
            openingAmount: drawer.openingAmount,
          },
        });
        return serializeDrawer(drawer);
      });
    },

    // ---------- POST /cash-drawer/sangria, POST /cash-drawer/suprimento ----------
    async registerCashMovementUsecase(input: {
      userId: string;
      type: "sangria" | "suprimento";
      amount: number;
      note?: string;
      category: MovementCategory;
      approvedByUserId?: string;
    }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // Validação 1: categoria deve ser um dos valores permitidos
        if (!ALLOWED_MOVEMENT_CATEGORIES.includes(input.category)) {
          throw Errors.invalidMovementCategory([...ALLOWED_MOVEMENT_CATEGORIES]);
        }

        // FOR UPDATE: sangria/suprimento validam ou alteram o saldo do caixa.
        // Sem o lock, duas sangrias concorrentes poderiam ler o mesmo `expected`
        // e ambas passarem na validação `amount <= expected`, resultando em saldo
        // negativo. O FOR UPDATE serializa o acesso à linha aberta.
        const drawer = await session.cashFlow.findOpenForUpdate();
        if (!drawer) throw Errors.cashDrawerNotOpen();

        if (input.type === "sangria") {
          const summary = await computeCashSummary(session, drawer);
          const over = round2(input.amount) - summary.expected;
          if (over > 0 && !moneyEq(input.amount, summary.expected)) {
            throw Errors.cashWithdrawalExceedsAvailable(summary.expected);
          }
        }

        // Validação 2: ler store_settings para verificar alçada de aprovação
        // (mesma transação da operação — o singleton carrega os três limites do
        // caixa; leitura fora do tx poderia validar com uma régua já trocada).
        const settings = await session.storeSettings.findSingleton();
        if (!settings) throw Errors.notFound("Configurações da loja");

        // Validação 3: se amount > cashHighValueThreshold, exigir approvedByUserId
        const amount = round2(input.amount);
        if (amount > settings.cashHighValueThreshold && !input.approvedByUserId?.trim()) {
          throw Errors.approvalRequired(amount, settings.cashHighValueThreshold);
        }

        // Validação 4: se approvedByUserId fornecido, validar que o usuário tem role manager ou cashier
        if (input.approvedByUserId?.trim()) {
          const approver = await session.users.findById(input.approvedByUserId);
          if (!approver) throw Errors.notFound("Usuário aprovador");
          if (approver.role !== "manager" && approver.role !== "cashier") {
            throw Errors.forbiddenRole();
          }
        }

        const movement = await session.cashFlow.recordMovement({
          drawerId: drawer.id,
          actorId: input.userId,
          type: input.type,
          amount,
          note: input.note,
          refOrderId: null,
          category: input.category,
        });

        const action = input.type === "sangria" ? "cash_drawer_sangria" : "cash_drawer_suprimento";
        const eventType = input.type === "sangria" ? "cash_drawer.sangria" : "cash_drawer.suprimento";
        await session.audit.record({
          actorId: input.userId,
          action,
          orderId: null,
          details: {
            drawerId: drawer.id,
            amount: movement.amount,
            note: movement.note,
            category: movement.category,
            approvedBy: input.approvedByUserId ?? null,
          },
        });
        await session.outbox.enqueue({
          room: CASH_DRAWER_ROOM,
          type: eventType,
          aggregateId: drawer.id,
          payload: {
            drawerId: drawer.id,
            amount: movement.amount,
          },
        });
        return serializeMovement(movement);
      });
    },

    // ---------- POST /cash-drawer/close ----------
    async closeCashDrawerUsecase(input: {
      userId: string;
      countedAmount: number;
      note?: string;
      denominations?: Array<{ denomination: number; quantity: number }>;
      justification?: string;
      approvedBy?: string;
    }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // FOR UPDATE: o fechamento calcula o esperado com base nas vendas e
        // movimentos da sessão, e grava o status 'closed'. Sem o lock, duas
        // requisições concorrentes poderiam ambas ler o drawer como aberto e
        // tentar fechar, resultando em dupla contagem ou estado inconsistente.
        // O lock garante que apenas uma transação feche por vez.
        const drawer = await session.cashFlow.findOpenForUpdate();
        if (!drawer) throw Errors.cashDrawerNotOpen();

        // Ler store_settings para obter tolerância e limite de aprovação
        const settings = await session.storeSettings.findSingleton();
        if (!settings) throw Errors.notFound("Configurações da loja");

        const summary = await computeCashSummary(session, drawer);
        const expected = summary.expected;
        const counted = round2(input.countedAmount);
        const difference = round2(counted - expected);

        // Validação 1: se |difference| > tolerance e justification vazia → 422
        if (Math.abs(difference) > settings.cashClosingTolerance && !input.justification?.trim()) {
          throw Errors.closingToleranceExceeded(difference, settings.cashClosingTolerance);
        }

        // Validação 2: se |difference| > requireApprovalAbove e approvedBy vazio → 422
        if (Math.abs(difference) > settings.cashClosingRequireApprovalAbove && !input.approvedBy?.trim()) {
          throw Errors.closingApprovalRequired(difference, settings.cashClosingRequireApprovalAbove);
        }

        // Validação 3: se denominations informado, soma deve bater com countedAmount
        if (input.denominations && input.denominations.length > 0) {
          const sumDenominations = input.denominations.reduce(
            (acc, d) => acc + d.denomination * d.quantity,
            0
          );
          const sumRounded = round2(sumDenominations);
          if (sumRounded !== counted) {
            throw Errors.closingDenominationsMismatch(counted, sumRounded);
          }
        }

        // Persistir denominations como JSON string (mesmo padrão de products.variations)
        const denominationsJson = input.denominations && input.denominations.length > 0
          ? JSON.stringify(input.denominations)
          : null;

        const closed = await session.cashFlow.close({
          drawerId: drawer.id,
          closedBy: input.userId,
          closedAt: new Date().toISOString(),
          closingExpected: expected,
          closingCounted: counted,
          closingDifference: difference,
          closingNote: input.note ?? null,
          closingDenominations: denominationsJson,
          closingJustification: input.justification?.trim() ?? null,
          closingApprovedBy: input.approvedBy?.trim() ?? null,
        });

        await session.audit.record({
          actorId: input.userId,
          action: "cash_drawer_closed",
          orderId: null,
          details: {
            drawerId: drawer.id,
            openedBy: drawer.openedBy,
            openingAmount: drawer.openingAmount,
            expected,
            counted,
            difference,
            note: input.note ?? null,
            denominations: input.denominations ?? null,
            justification: input.justification ?? null,
            approvedBy: input.approvedBy ?? null,
          },
        });
        await session.outbox.enqueue({
          room: CASH_DRAWER_ROOM,
          type: "cash_drawer.closed",
          aggregateId: drawer.id,
          payload: {
            drawerId: drawer.id,
            expected,
            counted,
            difference,
          },
        });
        return { ...serializeDrawer(closed), cashSalesTotal: summary.salesSum };
      });
    },

    // ---------- GET /cash-drawer/summary ----------
    // Agrega a conferência das sessões que interseccionam [from, to]: esperado,
    // contado e diferença por caixa, com totais para o relatório do gerente.
    async sumCashDrawersSummaryUsecase(input: { from: string; to: string }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const rows = await session.cashFlow.listIntersecting(input.from, input.to);

        // Sessão a sessão, sequencial: é o mesmo client da transação, então o
        // `Promise.all` por cima não dá paralelismo — só a depreciação do pg.
        const sessions: Array<
          ReturnType<typeof serializeDrawer> & {
            openedByName: string | null;
            cashSalesTotal: number;
            cashSalesCount: number;
            expected: number | null;
            counted: number | null;
            difference: number | null;
          }
        > = [];
        for (const d of rows) {
          const summary = await computeCashSummary(session, d);
          sessions.push({
            ...serializeDrawer(d),
            openedByName: await nameOf(session, d.openedBy),
            cashSalesTotal: summary.salesSum,
            cashSalesCount: summary.sales.length,
            expected: d.closedAt != null ? d.closingExpected : summary.expected,
            counted: d.closingCounted,
            difference: d.closingDifference,
          });
        }

        const closedSessions = sessions.filter((s) => s.status === "closed");
        const sum = (sel: (s: (typeof sessions)[number]) => number | null | undefined) =>
          round2(sessions.reduce((acc, s) => acc + (sel(s) ?? 0), 0));

        // Totais de conferência contam apenas sessões fechadas: `closing_expected`
        // e `closing_counted` só existem depois do fechamento, e contá-lo senão
        // misturaria o "esperado ao vivo" com o contado das fechadas (diferença
        // distorcida). Fundo/vendas incluem o que já entrou, mesmo em aberto.
        const totalOpening = sum((s) => s.openingAmount);
        const totalSales = sum((s) => s.cashSalesTotal);
        const totalExpected = round2(closedSessions.reduce((acc, s) => acc + (s.expected ?? 0), 0));
        const totalCounted = round2(closedSessions.reduce((acc, s) => acc + (s.counted ?? 0), 0));
        const totalDifference = round2(totalCounted - totalExpected);
        const openExpected = round2(
          sessions.filter((s) => s.status === "open").reduce((acc, s) => acc + (s.expected ?? 0), 0)
        );

        return {
          sessions,
          totalOpening,
          totalSales,
          totalExpected,
          totalCounted,
          totalDifference,
          openCount: sessions.filter((s) => s.status === "open").length,
          openExpected,
        };
      });
    },
  };
}

export type CashFlowUsecases = ReturnType<typeof createCashFlowUsecases>;

// Reexports de tipo/constante consumidos por quem monta o input (rotas).
export { ALLOWED_MOVEMENT_CATEGORIES };

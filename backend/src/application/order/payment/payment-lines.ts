/**
 * Linhas de pagamento da comanda (pagamento fracionado, 1 linha por forma).
 *
 * Duas fases separadas de propósito: `planPaymentLines` só LÊ e valida, e
 * `upsertPaymentLines` só ESCREVE. O chamador roda a fase de leitura ANTES da
 * conferência `soma == total`: se o request deixou de fora uma linha
 * confirmada, a resposta honesta é "isso exige estorno", e não "a soma não
 * confere" — que mandaria o usuário corrigir um número que está certo.
 *
 * Compartilhado por `set-order-payments` e `register-payment` (legado).
 */
import { Errors } from "../../../domain/errors.js";
import { round2, moneyEq } from "../../../domain/money.js";
import type { TenantSession } from "../../ports/unit-of-work.js";
import type { OrderPaymentLineRow, OrderRow } from "../../ports/repositories.js";
import { serializePayment } from "../shared/order-serializer.js";

export type PaymentLineInput = {
  method: "cash" | "card" | "pix" | "other";
  amount: number;
  received?: number;
  confirmed?: boolean;
};

// Corretude do fluxo de caixa: pagamento em dinheiro confirmado só entra com
// caixa aberto no momento — senão a venda fica fora de qualquer sessão e a
// conferência da gaveta quebra. Roda na mesma transação da escrita do
// pagamento (no caso do fechamento do caixa, o pagamento/estorno roda depois
// da sessão ter sido marcada fechada e é rejeitado).
//
// FOR UPDATE: quando o pagamento é dinheiro confirmado, travamos a linha do
// drawer para evitar que duas transações concorrentes ambas leiam o drawer
// como aberto e insiram pagamentos que, somados, excedam o saldo disponível.
// O lock serializa o acesso à linha aberta dentro da transação.
export async function requireOpenDrawerForCash(session: TenantSession, method: string, confirmed: boolean) {
  if (method === "cash" && confirmed && !(await session.cashFlow.findOpenForUpdate())) {
    throw Errors.paymentRequiresOpenDrawer();
  }
}

// Rótulo em PT-BR das formas de pagamento, só para a mensagem de recusa (no
// payload o backend continua falando "cash"/"card"/"pix"/"other").
const PAYMENT_LABEL: Record<PaymentLineInput["method"], string> = {
  cash: "Dinheiro",
  card: "Cartão",
  pix: "Pix",
  other: "Outro",
};

// Aplica as linhas de pagamento na mesma transação da escrita (padrão do repo),
// a partir do plano já validado por `planPaymentLines`.
//
// Uma linha JÁ CONFIRMADA é dinheiro que já se mexeu, e o PUT não pode mais
// simplesmente "apagar tudo e reinserir":
//
//   - a gaveta não tem saldo próprio. `GET /cash-drawer/*` conta
//     `order_payment` com `method='cash' AND confirmed` na janela da sessão
//     (cash-flow.usecases.ts → cashPaymentsBetween) — apagar a linha tira o
//     dinheiro do relatório *retroativamente*, sem sangra, sem movimento de
//     estorno e sem rastro em auditoria, já que o dinheiro foi pro bolso do
//     garçom;
//   - o relatório de vendas soma toda linha de `order_payment` por forma
//     (report.usecases.ts), então cartão/pix confirmados também não podem
//     sumir em silêncio — por isso a guarda vale pra todos os métodos, e não
//     só pra `cash`;
//   - `DELETE /orders/:id/payments/:paymentId` já recusava linha confirmada
//     (invalidTransition). Seria incoerente (e pior) o PUT em lote conseguir
//     apagar o que o DELETE nega.
//
// Então o PUT deixou de ser destrutivo e passou a ter 3 casos, nesta ordem:
//
//   1. PRESERVA a linha confirmada que continua na lista com mesmo método e
//      mesmo valor (só `received`/`change` podem mudar). Mantém id,
//      `confirmed_at` e `confirmed_by` — a identidade do dinheiro que a gaveta
//      reconcilia. É o que torna o PUT repetível sem efeito colateral.
//   2. RECUSA a linha confirmada que some da lista. O estorno é explícito e
//      registrado (cancelamento da comanda, que gera a sangria, ou sangria no
//      caixa) — nunca implícito num reenvio.
//   3. Linhas não confirmadas continuam sendo reescritas livremente: não há
//      dinheiro envolvido.
//
// `orders.payment_method` continua como denormalizado de exibição — método
// único → ele; mais de um → null (o client consome `payments[]` pra exibir o
// detalhe).
type PaymentPlan = {
  /** Linhas confirmadas mantidas: a linha da nova lista que casa com cada uma. */
  preserved: Array<{ row: OrderPaymentLineRow; line: PaymentLineInput }>;
  /** Índices de `lines` que casaram com uma confirmada (não reinserir). */
  matched: Set<number>;
  /** Ids que saem da tabela — só as não confirmadas que sobraram. */
  dropIds: string[];
};

/**
 * Lê as linhas de pagamento atuais e decide o que acontece com cada uma.
 * Recusa (invalid_transition) qualquer linha já CONFIRMADA que a nova lista
 * deixou de fora. Não escreve nada.
 */
export async function planPaymentLines(
  session: TenantSession,
  order: OrderRow,
  lines: PaymentLineInput[],
): Promise<PaymentPlan> {
  // Leitura ANTES do delete, na mesma transação: a guarda precisa enxergar as
  // linhas confirmadas que o request deixou de fora.
  const existing = await session.orders.listPaymentLines(order.id);

  // Casa 1:1 cada confirmada existente com uma linha da nova lista (mesmo
  // método + mesmo valor). `matched` impede que uma linha da nova lista
  // "adote" duas confirmadas — no dinheiro seria o caminho pra preservar uma e
  // deixar a outra sem par (e, portanto, recusada).
  const matched = new Set<number>();
  const preserved: PaymentPlan["preserved"] = [];
  for (const current of existing) {
    if (!current.confirmed) continue; // não confirmada é reescrita à vontade
    const idx = lines.findIndex(
      (l, i) => !matched.has(i) && l.method === current.method && moneyEq(l.amount, current.amount)
    );
    if (idx === -1) {
      throw Errors.invalidTransition(
        `Pagamento já confirmado (${PAYMENT_LABEL[current.method]} de R$ ${current.amount.toFixed(2)}) não pode sair da lista: o estorno precisa ser explícito. Reenvie mantendo a linha ou estorne pelo fluxo de caixa.`
      );
    }
    matched.add(idx);
    preserved.push({ row: current, line: lines[idx] });
  }

  const keptIds = new Set(preserved.map((p) => p.row.id));
  return { preserved, matched, dropIds: existing.filter((p) => !keptIds.has(p.id)).map((p) => p.id) };
}

export async function upsertPaymentLines(
  session: TenantSession,
  order: OrderRow,
  userId: string,
  lines: PaymentLineInput[],
  plan: PaymentPlan
) {
  const { preserved, matched } = plan;

  // A fase de leitura já recusou qualquer linha confirmada fora da lista, e a
  // transação aborta por `throw` — então aqui o delete só alcança as não
  // confirmadas que sobraram, e nunca uma linha preservada.
  if (plan.dropIds.length > 0) {
    await session.orders.deletePaymentLines(plan.dropIds);
  }

  const rows: OrderPaymentLineRow[] = [];

  for (const { row, line } of preserved) {
    // A linha preservada fica CONFIRMADA mesmo que o request mande
    // `confirmed: false`: o dinheiro já está na gaveta, e desconfirmar aqui
    // seria a mesma sangra do caso 2 por outro nome. Só o troco pode mudar.
    // `requireOpenDrawerForCash` também não roda: a guarda foi cumprida na
    // confirmação original e aqui não entra dinheiro novo — cobrá-la de novo
    // quebraria justamente a repetição segura que o caso 1 promete.
    const isCash = line.method === "cash";
    const received = isCash ? (line.received != null ? line.received : line.amount) : null;
    if (isCash && received != null && received < line.amount) {
      throw Errors.validationFailed({ field: "received", reason: "dinheiro recebido menor que o valor a pagar" });
    }
    const change = isCash && received != null ? round2(received - line.amount) : null;
    if ((received == null) === (row.received == null) && moneyEq(received ?? 0, row.received ?? 0) && moneyEq(change ?? 0, row.change ?? 0)) {
      rows.push(row); // nada mudou: não reescreve (preserva created_at)
      continue;
    }
    const updated = await session.orders.updatePaymentLineReceived(row.id, { received, change });
    rows.push(updated);
  }

  for (let i = 0; i < lines.length; i++) {
    if (matched.has(i)) continue; // já preservada acima
    const line = lines[i];
    await requireOpenDrawerForCash(session, line.method, Boolean(line.confirmed));
    const isCash = line.method === "cash";
    const confirmed = Boolean(line.confirmed);
    const received = isCash ? (line.received != null ? line.received : line.amount) : null;
    if (isCash && confirmed && received != null && received < line.amount) {
      throw Errors.validationFailed({ field: "received", reason: "dinheiro recebido menor que o valor a pagar" });
    }
    const change = isCash && received != null ? round2(received - line.amount) : null;
    const row = await session.orders.insertPaymentLine({
      orderId: order.id,
      method: line.method,
      amount: round2(line.amount),
      received,
      change,
      confirmed,
      confirmedAt: confirmed ? new Date().toISOString() : null,
      confirmedBy: confirmed ? userId : null,
      createdBy: userId,
    });
    rows.push(row);
  }

  const methods = [...new Set(rows.map((r) => r.method))];
  const allConfirmed = rows.length > 0 && rows.every((r) => r.confirmed);
  await session.orders.updatePaymentSummary(order.id, {
    paymentMethod: methods.length === 1 ? methods[0] : null,
    // Um PUT que só reenvia as mesmas linhas não pode regrampar "quando a
    // comanda foi quitada" — o que a gaveta e os relatórios reconciliam é o
    // `confirmed_at` da linha de pagamento, não este denormalizado.
    paymentConfirmedAt: allConfirmed ? order.paymentConfirmedAt ?? new Date().toISOString() : null,
    paymentConfirmedBy: allConfirmed ? order.paymentConfirmedBy ?? userId : null,
  });

  return {
    // `payments` é o estado final da comanda (preservadas + novas) — é o que
    // viaja nos enqueueEvent, então o cash-drawer e a cozinha recebem sempre o
    // conjunto coerente, e não só o que o request mandou.
    payments: rows.map(serializePayment),
    // Auditoria: distingue o que foi reaproveitado do que é novo, senão o log
    // diria "created" para um pagamento que já estava confirmado na gaveta.
    // `rows` são as preservadas + as inseridas agora; o que sobrou é inserção.
    reused: preserved.map((p) => p.row.id),
    created: rows.filter((r) => !preserved.some((p) => p.row.id === r.id)).map((r) => r.id),
  };
}

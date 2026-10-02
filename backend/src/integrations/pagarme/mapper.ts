import { round2 } from "../../domain/money.js";
import type { GatewayCharge, GatewayChargeRequest, GatewayPixData, PaymentMethod, PaymentStatus } from "../../domain/payment.js";
import type { PagarmeOrderResponse, PagarmePayment } from "./types.js";

// Tradução entre o dialeto do Pagar.me e o modelo interno.
//
// Regras deste arquivo:
//
//   1. NENHUMA regra de negócio. Aqui só se converte nome, unidade e formato.
//      Se aparece um "se o status for X então o pedido vira Y", está no lugar
//      errado.
//   2. A borda é onde existem centavos. O resto do app fala reais (`real` no
//      schema), porque NUMERIC devolveria string do node-postgres e quebraria
//      round2/moneyEq (ver domain/money.ts).
//   3. TUDO tolerante ao desconhecido. A doc oficial não enumera status, não
//      documenta onde o QR do Pix vem e o schema de resposta da página de
//      criação está copiado do endpoint de cobrança. Então: campo faltando vira
//      `undefined`, status não reconhecido vira `null` (e NÃO vira um palpite),
//      e quem chama decide o que fazer — o worker marca o evento para
//      reconciliação em vez de gravar estado inventado.

/** Reais → centavos, que é a unidade que a API do Pagar.me usa em todo amount. */
export function toCents(reais: number): number {
  return Math.round(reais * 100);
}

/** Centavos → reais. */
export function fromCents(cents: number | undefined): number | undefined {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return undefined;
  return round2(cents / 100);
}

/**
 * Status do gateway → status local.
 *
 * A doc oficial NÃO lista os valores possíveis (só exemplifica `paid`), então o
 * mapa é por comparação case-insensitive e cobre a grafia americana e britânica
 * de "canceled". Um valor fora daqui devolve `null` de propósito: gravar
 * "PENDING" porque o gateway mandou algo novo seria inventar estado financeiro,
 * e o efeito colateral errado (mostrar pendente como pago, ou o contrário) é
 * pior que não atualizar.
 */
export function mapStatus(value: string | undefined | null): PaymentStatus | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  switch (v) {
    case "pending":
    case "waiting":
      return "pending";
    case "processing":
      return "processing";
    case "paid":
    case "captured":
    case "confirmed":
      return "paid";
    case "failed":
    case "chargeback":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "partially_refunded":
      return "partially_refunded";
    case "refunded":
      return "refunded";
    default:
      return null;
  }
}

/**
 * Meio de pagamento do gateway → método local.
 *
 * A doc descreve os valores como "credit_card, boleto, Pix, Debit Card" — é
 * prosa, não enum, e "Pix" vem com P maiúsculo. Por isso a comparação ignora
 * caixa. `boleto` e débito não têm equivalente em `PaymentMethod` (o PDV
 * trabalha com Pix e cartão), então devolvem `null` em vez de virar algo
 * inventado.
 */
export function mapPaymentMethod(value: string | undefined | null): PaymentMethod | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "pix") return "pix";
  if (v === "credit_card" || v === "creditcard") return "credit_card";
  return null;
}

/**
 * Procura o QR do Pix no payload, tolerando os caminhos que a documentação
 * não garante.
 *
 * A referência oficial de criação de pedido NÃO menciona `qr_code`, `txid` nem
 * `expires_at` em lugar nenhum, e o schema de resposta dela está copiado do
 * endpoint de cobrança. Sabendo que o dado existe (é o produto do Pix) mas não
 * onde vem, a saída é varrer os caminhos plausíveis em ordem e pegar o primeiro
 * que traga conteúdo — em vez de escolher um e ficar devolvendo pagamento sem
 * QR para sempre.
 *
 * A ordem importa: o mais específico primeiro (`payments[].pix`), porque é o
 * que a API de hoje devolve; os outros são fallback para variação de versão.
 */
function extractPix(order: PagarmeOrderResponse | undefined): GatewayPixData | undefined {
  if (!order) return undefined;

  const fromPixObject = (pix: Record<string, unknown> | undefined | null): GatewayPixData | undefined => {
    if (!pix) return undefined;
    const data: GatewayPixData = {
      qrCode: typeof pix["qr_code"] === "string" ? (pix["qr_code"] as string) : undefined,
      qrCodeBase64:
        typeof pix["qr_code_base64"] === "string" ? (pix["qr_code_base64"] as string) : undefined,
      qrCodeUrl: typeof pix["qr_code_url"] === "string" ? (pix["qr_code_url"] as string) : undefined,
      txid: typeof pix["txid"] === "string" ? (pix["txid"] as string) : undefined,
      expiresAt: typeof pix["expires_at"] === "string" ? (pix["expires_at"] as string) : undefined,
    };
    // `qr_code_base64_file` é o PNG hospedado pelo gateway: entra como URL
    // quando não veio o base64, porque é o que o frontend consegue exibir
    // direto sem montar um data URI gigante no <img src>.
    if (!data.qrCodeBase64 && typeof pix["qr_code_base64_file"] === "string") {
      data.qrCodeUrl = (pix["qr_code_base64_file"] as string) || data.qrCodeUrl;
    }
    const temAlgo = Object.values(data).some((v) => Boolean(v));
    return temAlgo ? data : undefined;
  };

  // 1) payments[].pix — caminho de hoje.
  for (const payment of order.payments ?? []) {
    const direto = fromPixObject(payment.pix as Record<string, unknown> | undefined);
    if (direto) return direto;
    // 2) payments[].last_transaction.pix
    const viaTransaction = fromPixObject(
      payment.last_transaction?.pix as Record<string, unknown> | undefined,
    );
    if (viaTransaction) return viaTransaction;
    // 3) QR solto na transação, sem o embrulho `pix`.
    const last = payment.last_transaction;
    if (last) {
      const solto = fromPixObject(last as unknown as Record<string, unknown>);
      if (solto) return solto;
    }
  }
  // 4) no topo da resposta.
  return fromPixObject(order.pix as Record<string, unknown> | undefined);
}

/**
 * O payload de pagamento relevante. Uma cobrança pode ter vários `payments[]`
 * (o pedido aceita mais de um meio); a resolução é "o primeiro cujo status é
 * reconhecível", senão o primeiro, senão nada. Filtrar por método em vez de
 * posição importaria mais do que a doc sustenta aqui.
 */
function pickPayment(order: PagarmeOrderResponse | undefined): PagarmePayment | undefined {
  const payments = order?.payments ?? [];
  if (payments.length === 0) return undefined;
  return payments.find((p) => mapStatus(p.status) !== null) ?? payments[0];
}

/**
 * Resposta do gateway → `GatewayCharge` do domínio.
 *
 * `providerOrderId` é obrigatório no tipo do domínio: se o payload não trouxe
 * id, não há como reconciliar depois, então isso é erro explícito em vez de
 * linha órfã.
 */
export function mapOrderToCharge(order: PagarmeOrderResponse | undefined): GatewayCharge {
  if (!order?.id) {
    throw new Error("resposta do Pagar.me sem id: não dá para reconciliar a cobrança depois");
  }

  const payment = pickPayment(order);
  const transaction = payment?.last_transaction ?? order.last_transaction;
  const status = mapStatus(payment?.status) ?? mapStatus(order.status) ?? "pending";

  // A doc não diz se o amount do gateway é o do pagamento ou o total do pedido;
  // o do pagamento é o mais próximo do que estamos cobrindo. `fromCents`
  // devolve `undefined` quando o campo não veio, e o chamador decide.
  const amountFromPayment = fromCents(payment?.amount);
  const amountFromOrder = fromCents(order.amount);

  const charge: GatewayCharge = {
    providerOrderId: order.id,
    // O V5 prefixa por tipo: `or_` pedido, `ch_` cobrança, `pay_` pagamento. O
    // id do topo pode ser qualquer um dos três dependendo de qual endpoint
    // respondeu, então guardamos onde ele estiver em vez de assumir.
    providerChargeId: order.id.startsWith("ch_") ? order.id : undefined,
    providerPaymentId: payment?.id ?? (order.id.startsWith("pay_") ? order.id : undefined),
    status,
    // `0` aqui significa "a doc não mandou amount" — não "custou R$ 0,00". Quem
    // grava tem de conferir contra o valor local da comanda antes de persistir,
    // e a spec §12 já proíbe tratar o corpo da criação como pagamento
    // confirmado. Mantido como 0 para o tipo do domínio continuar simples.
    amount: round2(amountFromPayment ?? amountFromOrder ?? 0),
    paidAmount: fromCents(payment?.paid_amount ?? order.paid_amount),
    refundedAmount: fromCents(payment?.refunded_amount),
    pix: extractPix(order),
    // Só o resumo que a V5 devolve: 4 últimos e bandeira. PAN/CVV não existem
    // nestes tipos de propósito.
    cardLast4: transaction?.card?.last_four_digits,
    cardBrand: transaction?.card?.brand,
  };

  return charge;
}

/**
 * Monta o corpo de `POST /orders` exatamente como a documentação declara.
 *
 * Pontos confirmados na doc oficial e respeitados aqui:
 *   - `items` e `payments` são obrigatórios, e `items[].code` também;
 *   - `items[].amount` é o valor UNITÁRIO — e o pedido não tem campo de total,
 *     então a soma dos itens é o que fecha o valor;
 *   - `customer` ou `customer_id` é obrigatório; dentro de customer só `name`
 *     é required;
 *   - cartão entra por `card_id`/`card_token`, nunca por `card` com número e
 *     CVV (a doc avisa em caixa alta: dado aberto de cartão no servidor é o que
 *     exige PCI). Não há campo de PAN neste arquivo;
 *   - `code` é a referência da loja, no máximo 52 caracteres.
 *
 * `closed: false` cria o pedido ABERTO, que é o que faz sentido para Pix e
 * cartão: o pedido existe aguardando confirmação, e o webhook é quem fecha.
 * Um pedido já fechado no gateway não teria como receber o pagamento depois.
 */
export function buildCreateOrderBody(request: GatewayChargeRequest): Record<string, unknown> {
  const items = request.items.map((item) => ({
    code: item.code.slice(0, 52),
    description: item.description,
    quantity: item.quantity,
    amount: toCents(item.unitAmount),
  }));

  const payment: Record<string, unknown> = { payment_method: request.method };

  if (request.method === "credit_card") {
    const creditCard: Record<string, unknown> = {
      operation_type: "auth_and_capture",
      installments: request.installments ?? 1,
    };
    if (request.cardToken) creditCard["card_token"] = request.cardToken;
    if (request.cardId) creditCard["card_id"] = request.cardId;
    payment["credit_card"] = creditCard;
  }

  // `expiresInSeconds` (validade do Pix) NÃO é enviado: a doc oficial consultada
  // não documenta nenhum campo de expiração de Pix no corpo de criação — o
  // próprio QR, que é onde moraria a expiração, não aparece naquele documento.
  // Mandar um campo adivinhado seria pior que não mandar: o gateway ignora
  // desconhecido, mas se o nome bater com algo errado a cobrança nasce com
  // validade que ninguém pediu. O default do gateway vale, e a reconciliação
  // lê `expires_at` do QR quando ele aparecer.

  // split fica de fora por decisão de escopo (o repo é single-tenant, sem
  // `stores` nem recebedor — ver PLANO_PAGARME.md). O lugar dele na V5 é
  // `payments[].split[]`, POR PAGAMENTO, com `recipient_id` e
  // `options{liable, charge_processing_fee, charge_remainder_fee}` — e não o
  // `split_rules` de topo que o plano do repo assume.
  const body: Record<string, unknown> = {
    code: request.code.slice(0, 52),
    items,
    customer: {
      name: request.customer.name,
      ...(request.customer.email ? { email: request.customer.email } : {}),
      ...(request.customer.document ? { document: request.customer.document } : {}),
      ...(request.customer.code ? { code: request.customer.code } : {}),
    },
    payments: [payment],
    closed: false,
    metadata: { order_id: request.orderId },
  };

  return body;
}
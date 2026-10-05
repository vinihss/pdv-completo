// Tipos do payload EXTERNO do Pagar.me V5.
//
// Regra do arquivo: TUDO opcional. Estes tipos descrevem o que a documentação
// oficial mostra, e o que ela mostra é incompleto — o mapper (mapper.ts) tem que
// sobreviver a campo faltando, a campo novo e a valor que a gente não conhecia.
//
// ## O que foi confirmado na doc oficial, e o que NÃO foi
//
// CONFIRMADO (referência "Criar pedido", OpenAPI 3.1, server
// https://api.pagar.me/core/v5, securitySchemes: http/basic):
//   - `POST /orders` exige `items` e `payments`; `items[].code` é obrigatório;
//   - `items[].amount` é o valor UNITÁRIO, e o pedido NÃO tem campo de total;
//   - `customer` ou `customer_id` é obrigatório; dentro de `customer`, só `name`
//     é required;
//   - `payments[].payment_method` — a doc descreve os valores como
//     "credit_card, boleto, Pix, Debit Card" (é prosa, não enum);
//   - cartão por `payments[].credit_card.card_id` / `.card_token`, e a doc avisa
//     em caixa alta para não enviar `card` com número/CVV (PCI);
//   - split é `payments[].split[]` (POR PAGAMENTO), com `recipient_id`,
//     `amount`/`type` e `options{liable, charge_processing_fee,
//     charge_remainder_fee}` — NÃO é `split_rules` no topo;
//   - `code` é a referência da loja, máx. 52 caracteres; `closed` decide se o
//     pedido nasce aberto ou fechado.
//
// NÃO CONFIRMADO — e é por isso que o mapper é tolerante:
//   - o schema de RESPOSTA dessa página está copiado do endpoint de COBRANÇA
//     (id `ch_...`, sem `items` e sem `payments[]`), então ele NÃO descreve o
//     objeto de pedido que volta;
//   - `qr_code`, `qr_code_base64`, `qr_code_url`, `qr_code_base64_file`, `txid`
//     e `expires_at` NÃO aparecem em lugar nenhum daquele documento;
//   - a doc NÃO enumera os valores de `status` (só exemplifica "paid" e
//     "captured", este último em `last_transaction`, que é outro campo);
//   - não há header de idempotência documentado.
//
// Consequência de projeto, e ela é o item mais importante deste arquivo: a
// criação da cobrança NÃO pode ser lida como "pago" (spec §12), e o QR é
// procurado em vários caminhos possíveis porque nenhum deles é garantido pela
// doc. O que confirma pagamento é o webhook, e o que preenche o QR faltante é
// a reconciliação.

/** Payload de `POST /orders` / `GET /orders/{id}`, como a doc descreve. */
export interface PagarmeOrderResponse {
  /** `or_...` no pedido, `ch_...` numa cobrança — por isso string. */
  id?: string;
  code?: string;
  status?: string;
  amount?: number;
  paid_amount?: number;
  payments?: PagarmePayment[];
  customer?: PagarmeCustomer;
  items?: PagarmeOrderItem[];
  last_transaction?: PagarmeTransaction;
  metadata?: unknown;
  /** Alguns payloads entregam o QR aqui em vez de dentro de `payments[]`. */
  pix?: PagarmePix;
}

export interface PagarmePayment {
  id?: string;
  payment_method?: string;
  status?: string;
  amount?: number;
  paid_amount?: number;
  refunded_amount?: number;
  paid_at?: string;
  card?: PagarmeCard;
  pix?: PagarmePix;
  last_transaction?: PagarmeTransaction;
  split?: PagarmeSplit[];
}

/**
 * Dados do Pix. `qr_code_base64_file` é o PNG que o gateway hospeda — é o
 * formato mais direto de o frontend exibir sem montar data URI gigante no
 * navegador.
 */
export interface PagarmePix {
  qr_code?: string;
  qr_code_base64?: string;
  qr_code_base64_file?: string;
  qr_code_url?: string;
  txid?: string;
  expires_at?: string;
}

/** Cartão salvo. Só o que a V5 devolve é o resumo — nunca o PAN. */
export interface PagarmeCard {
  id?: string;
  first_six_digits?: string;
  last_four_digits?: string;
  brand?: string;
  holder_name?: string;
  exp_month?: number;
  exp_year?: number;
}

export interface PagarmeTransaction {
  id?: string;
  transaction_type?: string;
  amount?: number;
  status?: string;
  success?: boolean;
  card?: PagarmeCard;
  acquirer_return_code?: string;
  gateway_response?: { code?: string; message?: string };
  /**
   * O QR do Pix aninhado na transação. Não é o caminho principal (o de hoje é
   * `payments[].pix`), mas existe aqui porque a doc oficial não diz onde o QR
   * vem — e o mapper varre os dois. Declarar o campo é o que permite o mapper
   * olhar sem `as any`.
   */
  pix?: PagarmePix;
}

export interface PagarmeSplit {
  id?: string;
  gateway_id?: string;
  amount?: number;
  type?: string;
  recipient?: { id?: string; name?: string };
  options?: {
    liable?: boolean;
    charge_processing_fee?: boolean;
    charge_remainder_fee?: boolean;
  };
}

export interface PagarmeCustomer {
  id?: string;
  name?: string;
  email?: string;
  document?: string;
  type?: string;
  code?: string;
}

export interface PagarmeOrderItem {
  code?: string;
  description?: string;
  quantity?: number;
  amount?: number;
}

/**
 * Corpo do webhook. A doc lista os TIPOS (`order.paid`, `order.payment_failed`,
 * `order.canceled`, `charge.paid`, `charge.refunded`, ...) mas não documenta o
 * envelope; o padrão do Core V5 é `{ id, type, created_at, data }`, com `data`
 * sendo o objeto do recurso. Por isso `data` é do tipo mais tolerante possível
 * e o mapper é quem olha dentro dele.
 */
export interface PagarmeWebhookPayload {
  id?: string;
  type?: string;
  created_at?: string;
  data?: PagarmeOrderResponse & {
    charges?: PagarmeOrderResponse[];
    last_transaction?: PagarmeTransaction;
  };
}

/** Resposta de erro do gateway: a doc não especifica o envelope (vazio no OpenAPI). */
export interface PagarmeErrorBody {
  message?: string;
  errors?: Array<{ message?: string; field?: string }>;
}
// Erros de domínio — cada um carrega o `code` estável da tabela §7.11
// e o status HTTP correspondente, pra camada http/ nunca precisar
// redecidir esse mapeamento em vários lugares.

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validationFailed: (details?: unknown) =>
    new AppError("validation_failed", 400, "Dados inválidos.", details),
  identificationRequired: () =>
    new AppError("identification_required", 400, "Informe mesa, cliente ou rótulo da comanda."),
  paymentMethodDisabled: () =>
    new AppError("payment_method_disabled", 400, "Forma de pagamento desabilitada."),
  deliveryDisabled: () =>
    new AppError("delivery_disabled", 400, "Pedidos por delivery estão desabilitados."),
  invalidKitchenThresholds: () =>
    new AppError("invalid_kitchen_thresholds", 400, "O limiar urgente precisa ser maior que o de alerta."),
  invalidTransition: (msg = "Transição de status inválida.") =>
    new AppError("invalid_transition", 400, msg),
  // Mesmo código de invalidTransition, mas 409: o eixo delivery e o
  // cancelamento do cliente são conflito de estado do pedido (docs/05
  // "Conflitos"), não erro de validação de request (docs/01 usa 400 no
  // PATCH de item, que é outro contexto).
  invalidDeliveryTransition: (msg = "Transição de entrega inválida.") =>
    new AppError("invalid_transition", 409, msg),
  pinNotAllowedHere: () =>
    new AppError("pin_not_allowed_here", 400, "PIN só pode ser definido via reset-pin."),
  unauthorized: (msg = "Token ausente, inválido ou expirado.") =>
    new AppError("unauthorized", 401, msg),
  invalidCredentials: () =>
    new AppError("invalid_credentials", 401, "PIN incorreto."),
  forbiddenRole: () =>
    new AppError("forbidden_role", 403, "Sem permissão para esta ação."),
  notFound: (what = "Recurso") =>
    new AppError("not_found", 404, `${what} não encontrado.`),
  serviceUnavailable: (msg = "Serviço indisponível.") =>
    new AppError("service_unavailable", 503, msg),
  orderNotOpen: () =>
    new AppError("order_not_open", 409, "Esta comanda já está fechada."),
  itemAlreadyDelivered: () =>
    new AppError("item_already_delivered", 409, "Item já entregue não pode ser removido."),
  concurrencyConflict: (currentVersion: number) =>
    new AppError(
      "concurrency_conflict",
      409,
      "Este item foi alterado por outra pessoa. Recarregue e tente novamente.",
      { currentVersion }
    ),
  pendingItems: (pendingItems: unknown[]) =>
    new AppError("pending_items", 409, "Ainda há itens não entregues nesta comanda.", { pendingItems }),
  paymentNotRegistered: () =>
    new AppError("payment_not_registered", 409, "Registre a forma de pagamento antes de fechar."),
  paymentNotConfirmed: () =>
    new AppError("payment_not_confirmed", 409, "Confirme o recebimento das formas de pagamento antes de fechar."),
  invalidPaymentTotal: () =>
    new AppError("invalid_payment_total", 409, "A soma das formas de pagamento não confere com o total da comanda."),
  tooManyAttempts: () =>
    new AppError("too_many_attempts", 429, "Muitas tentativas. Aguarde um minuto."),
  addressLimitReached: () =>
    new AppError("address_limit_reached", 409, "Limite de 3 endereços por cliente atingido."),
  duplicatePhone: () =>
    new AppError("duplicate_phone", 409, "Telefone já cadastrado."),
  invalidCourierRole: () =>
    new AppError("invalid_courier_role", 400, "Usuário indicado não é um entregador."),
  cashDrawerAlreadyOpen: () =>
    new AppError("cash_drawer_already_open", 409, "Já existe um caixa aberto. Feche-o antes de abrir outro."),
  cashDrawerNotOpen: () =>
    new AppError("cash_drawer_not_open", 409, "Nenhum caixa aberto para esta operação."),
  paymentRequiresOpenDrawer: () =>
    new AppError("cash_drawer_not_open", 409, "Pagamento em dinheiro exige caixa aberto. Abra o caixa antes de confirmar a venda."),
  cashRefundRequiresOpenDrawer: () =>
    new AppError("cash_drawer_not_open", 409, "Não há caixa aberto para registrar o estorno em dinheiro."),
  cashDrawerAlreadyClosed: () =>
    new AppError("cash_drawer_already_closed", 409, "Este caixa já está fechado."),
  cashWithdrawalExceedsAvailable: (available: number) =>
    new AppError(
      "cash_withdrawal_exceeds_available",
      409,
      `Sangria maior que o valor disponível no caixa (${available.toFixed(2)}).`,
      { available }
    ),
  tableNotFound: (tableId: string) =>
    new AppError("table_not_found", 404, "Mesa não encontrada.", { tableId }),
  tableOccupied: () =>
    new AppError("table_occupied", 409, "Esta mesa já está ocupada por outra comanda aberta."),
  insufficientStock: (productId: string, name: string, available: number) =>
    new AppError(
      "insufficient_stock",
      409,
      `Estoque insuficiente de ${name} (disponível: ${available}).`,
      { productId, name, available }
    ),
  variationRequired: (productName: string, groups: string[]) =>
    new AppError(
      "variation_required",
      422,
      `Escolha as opções obrigatórias de ${productName}.`,
      { productName, groups }
    ),
  variationInvalid: (productName: string, group: string, option: string) =>
    new AppError("variation_invalid", 422, `Opção indisponível em ${productName}: ${group} → ${option}.`, {
      productName,
      group,
      option,
    }),
  // ---------- Embedded Signup / WhatsApp Cloud API ----------
  // Faltou config do APP da Meta (META_APP_ID / META_APP_SECRET /
  // WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID). 409 e não 400: é a instalação
  // que não está pronta, não um payload invalido.
  whatsappNotConfigured: (missing: string[]) =>
    new AppError(
      "whatsapp_not_configured",
      409,
      "O WhatsApp ainda não está configurado neste servidor.",
      { missing }
    ),
  // O code do Embedded Signup é de uso único e vive 30s. A Meta não diz
  // o que falhou (expirou? já usado? redirect_uri errado?), então a
  // mensagem é fixa e o motivo real fica no log do servidor.
  whatsappInvalidCode: () =>
    new AppError(
      "whatsapp_invalid_code",
      400,
      "O código de autorização do WhatsApp é inválido ou expirou. Tente conectar de novo."
    ),
  // O cliente autorizou, mas o token não tem os escopos que a operação
  // exige (gerenciar a WABA + enviar mensagem). Detalhar quais faltam
  // evita o ping-pong de "conectou mas não avisa cliente".
  whatsappMissingScopes: (missing: string[]) =>
    new AppError(
      "whatsapp_missing_scopes",
      422,
      "A conta não autorizou o que o PDV precisa para operar o WhatsApp.",
      { missing }
    ),
  // Módulo já integrado (iFood/maps): uma conexão por vez, igual à
  // uq_whatsapp_single_active no banco.
  whatsappAlreadyConnected: (displayPhoneNumber: string | null) =>
    new AppError(
      "whatsapp_already_connected",
      409,
      "Já existe um WhatsApp conectado. Desconecte o atual para conectar outro.",
      { displayPhoneNumber }
    ),
  // A Meta respondeu erro no onboarding (register falhou, token sem
  // permissão). O detalhe vai junto para o gerente ver na UI.
  whatsappProviderError: (message: string, details?: unknown) =>
    new AppError("whatsapp_provider_error", 502, `A Meta recusou a conexão: ${message}`, details),
  // ---------- Pagar.me V5 (cobrança no gateway) ----------
  // Mesma lógica do WhatsApp: 409 e não 400/500 porque não é payload
  // inválido — é a instalação que ainda não está pronta. `missing` diz o que
  // falta (toggle, secret key) para o gerente não ficar adivinhando.
  pagarmeNotConfigured: (missing: string[]) =>
    new AppError(
      "pagarme_not_configured",
      409,
      "A cobrança no Pagar.me ainda não está configurada neste servidor.",
      { missing },
    ),
  // A cobrança existe do lado do gateway mas não aqui (ou nunca foi criada).
  // 404 e não "não encontrada" genérico: quem chama é o caixa, e a resposta
  // honesta é que o pagamento não existe, não que o pedido sumiu.
  paymentNotFound: (ref?: string) =>
    new AppError("payment_not_found", 404, "Cobrança não encontrada.", ref ? { ref } : undefined),
  // O gateway recusou a operação financeira (recusou o cartão, estorno não
  // elegível, valor acima do estornado...). 502: o pedido estava bem, quem
  // respondeu não foi. A mensagem vai pro log com o detalhe do provedor, não
  // pro cliente final.
  pagarmeProviderError: (message: string, details?: unknown) =>
    new AppError("pagarme_provider_error", 502, `O Pagar.me recusou a operação: ${message}`, details),
  // Estorno maior do que o que sobrou de estornável. 422 (e não 409): os
  // números são válidos, a combinação não é — mesma régua do variation_required.
  invalidRefundAmount: (requested: number, refundable: number) =>
    new AppError(
      "invalid_refund_amount",
      422,
      `Estorno de R$ ${requested.toFixed(2)} maior que o valor estornável (R$ ${refundable.toFixed(2)}).`,
      { requested, refundable },
    ),
  // Assinatura do webhook ausente ou não confere. 401: quem chamou não se
  // provou ser o Pagar.me. Mesmo código/mensagem do webhook do WhatsApp
  // (`invalid_signature`), porque é exatamente o mesmo caso.
  invalidSignature: () =>
    new AppError("invalid_signature", 401, "Assinatura do webhook inválida."),
};

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
  storeNotResolved: () => new AppError("store_not_resolved", 404, "Não foi possível identificar a loja. Acesse pelo subdomínio correto."),
  tenantMismatch: () => new AppError("tenant_mismatch", 403, "O login pertence a outra loja. Acesse pelo subdomínio correto."),
  storeInactive: () => new AppError("store_inactive", 403, "Esta loja está inativa ou suspensa."),
  // ---------- Pagar.me / PagarMe ----------
  paymentGatewayNotConfigured: () =>
    new AppError(
      "payment_gateway_not_configured",
      409,
      "O Pagar.me ainda não está configurado para esta loja. Solicite o cadastro no painel administrativo."
    ),
  recipientNotConfigured: () =>
    new AppError(
      "recipient_not_configured",
      409,
      "O Pagar.me não está configurado para esta loja. Cadastre o recebedor antes de processar pagamentos."
    ),
  recipientAlreadyConfigured: () =>
    new AppError(
      "recipient_already_configured",
      409,
      "Uma conta Pagar.me já está cadastrada para esta loja."
    ),
  recipientRejected: () =>
    new AppError(
      "recipient_rejected",
      403,
      "A conta Pagar.me desta loja foi rejeitada no KYC. Verifique a documentação no painel."
    ),
};
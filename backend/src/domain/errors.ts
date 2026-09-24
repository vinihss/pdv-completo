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
};

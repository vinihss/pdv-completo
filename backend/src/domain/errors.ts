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
  // Ping de localização sem entrega em rota. 409 (não 400/422): o payload
  // está válido, é o ESTADO do entregador que não permite — mesma régua do
  // invalid_transition / order_not_open.
  courierNotOnRoute: () =>
    new AppError(
      "courier_not_on_route",
      409,
      "Localização só é aceita com entrega em rota (out_for_delivery)."
    ),
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
  // ---------- Multi-tenant (registry `public.tenant`) ----------
  //
  // Códigos e status do §3.1 do `docs/15-multi-tenant-schema.md`, já que o
  // `tenant.middleware` da Fase 2 vai reaproveitar exatamente estes.
  //
  // 404 e nunca o tenant default: um `slug` fora do `CHECK` ou um subdomínio
  // que não existe no registry são "não é loja nenhuma", e cair no default seria
  // servir a loja errada para quem pediu a loja certa (a "regra de ouro" do
  // §4.8). O detalhe vai no log do servidor, não na resposta — o corpo não
  // ecoa o host que o cliente mandou.
  tenantNotResolved: () =>
    new AppError("tenant_not_resolved", 404, "Loja não encontrada para este endereço."),
  // A loja existe mas está suspensa: 403 (e não 404) para o dono da loja ver a
  // página de suspensão em vez de erro de certificado (§8 do doc 15).
  tenantInactive: (slug: string) =>
    new AppError("tenant_inactive", 403, "Esta loja está temporariamente indisponível.", { slug }),
  // A loja está no registry, mas o processo ainda não fala o schema dela —
  // estado que só existe entre a Fase 1 (registry) e a Fase 3 (schema
  // provisionado), e que o registry não consegue detectar sozinho.
  tenantSchemaUnavailable: (slug: string, schemaName: string) =>
    new AppError(
      "tenant_schema_unavailable",
      503,
      "Esta loja ainda não está disponível.",
      { slug, schemaName },
    ),
  // ---------- Device provisioning (docs/21-device-provisioning.md) ----------
  //
  // Códigos do PR 1 (provisionamento de aparelho por usuário). A régua de
  // status segue o resto do catálogo: 400 = conteúdo inválido (chave errada),
  // 403 = estado do recurso impede (revogada/aparelho não vinculado), 404 =
  // recurso inexistente. O exchange NÃO revela qual usuário a chave pertence
  // (nem se a chave é de alguém desativado): chave sem match cai em
  // `provisioning_key_invalid`, a mesma resposta de "código errado".
  provisioningKeyInvalid: () =>
    new AppError("provisioning_key_invalid", 400, "Chave de provisionamento inválida."),
  provisioningKeyExpired: () =>
    new AppError("provisioning_key_expired", 400, "Chave de provisionamento expirada."),
  provisioningKeyRevoked: () =>
    new AppError("provisioning_key_revoked", 403, "Chave de provisionamento revogada."),
  deviceUnknown: () =>
    new AppError("device_unknown", 404, "Aparelho não encontrado."),
  deviceRevoked: () =>
    new AppError("device_revoked", 403, "Aparelho revogado."),
  deviceNotProvisioned: () =>
    new AppError("device_not_provisioned", 403, "Este aparelho não está vinculado a este usuário."),
  // ---------- Fechamento de caixa com contagem (migration 0005) ----------
  // Validações do fechamento com denominação: diferença acima da tolerância
  // exige justificativa; acima do limite de alçada exige aprovação de gerente;
  // soma das cédulas deve bater com o valor declarado.
  closingJustificationRequired: (difference: number, tolerance: number) =>
    new AppError(
      "closing_justification_required",
      422,
      `Diferença de R$ ${Math.abs(difference).toFixed(2)} excede a tolerância de R$ ${tolerance.toFixed(2)}. Informe uma justificativa.`,
      { difference, tolerance },
    ),
  closingApprovalRequired: (difference: number, threshold: number) =>
    new AppError(
      "closing_approval_required",
      422,
      `Diferença de R$ ${Math.abs(difference).toFixed(2)} excede o limite de R$ ${threshold.toFixed(2)}. Informe o PIN do gerente aprovador.`,
      { difference, threshold },
    ),
  closingDenominationsMismatch: (expected: number, counted: number) =>
    new AppError(
      "closing_denominations_mismatch",
      422,
      `A soma das cédulas (R$ ${counted.toFixed(2)}) não confere com o valor informado (R$ ${expected.toFixed(2)}).`,
      { expected, counted },
    ),
  // ---------- Classificação de sangrias/suprimentos (Bloco 6 ROADMAP-CAIXA.md) ----------
  // Validações de categoria de movimento e alçada de aprovação para valores altos.
  invalidMovementCategory: (allowed: string[]) =>
    new AppError(
      "invalid_movement_category",
      422,
      `Categoria de movimento inválida. Valores permitidos: ${allowed.join(", ")}.`,
      { allowed },
    ),
  approvalRequired: (amount: number, threshold: number) =>
    new AppError(
      "approval_required",
      403,
      `Movimento de R$ ${amount.toFixed(2)} excede o limite de R$ ${threshold.toFixed(2)}. Aprovação necessária.`,
      { amount, threshold },
    ),
  closingToleranceExceeded: (difference: number, tolerance: number) =>
    new AppError(
      "closing_tolerance_exceeded",
      422,
      `Diferença de R$ ${Math.abs(difference).toFixed(2)} excede a tolerância de R$ ${tolerance.toFixed(2)}. Informe uma justificativa.`,
      { difference, tolerance },
    ),
  // ---------- Estorno de pagamentos (Bloco 4 ROADMAP-CAIXA.md) ----------
  // Validações do estorno: pagamento precisa estar confirmado e o valor do
  // estorno não pode exceder o valor do pagamento (nem a soma de estornos
  // anteriores).
  refundPaymentNotConfirmed: () =>
    new AppError("payment_not_confirmed", 422, "Pagamento não confirmado. Confirme o pagamento antes de estornar."),
  refundExceedsPayment: (requested: number, available: number) =>
    new AppError(
      "refund_exceeds_payment",
      422,
      `Estorno de R$ ${requested.toFixed(2)} excede o valor disponível (R$ ${available.toFixed(2)}).`,
      { requested, available },
    ),
};

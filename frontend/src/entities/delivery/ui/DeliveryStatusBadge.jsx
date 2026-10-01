import React from "react";

const DELIVERY_STATUS_LABEL = {
  awaiting_courier: "Aguardando",
  out_for_delivery: "A caminho",
  delivered: "Entregue",
  failed: "Falhou",
  cancelled: "Cancelada",
};
const DELIVERY_STATUS_CLASS = {
  awaiting_courier: "bg-amber-500/15 text-amber-400",
  out_for_delivery: "bg-sky-500/15 text-sky-400",
  delivered: "bg-emerald-500 text-emerald-950",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "bg-stone-700/50 text-stone-400",
};

// "cancelled" entrou no badge junto com a distinção de 0018: é o
// cancelamento (manager ou cliente), diferente de `failed` ("problema na
// entrega"). Sem a entrada própria, um pedido cancelado aparecia com o texto do
// status cru.
export default function DeliveryStatusBadge({ status, className = "" }) {
  return (
    <span
      className={`text-[11px] font-bold px-2 py-1 rounded-full ${
        DELIVERY_STATUS_CLASS[status] ?? DELIVERY_STATUS_CLASS.awaiting_courier
      } ${className}`}
    >
      {DELIVERY_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * Transições que o BALCÃO pode fazer, por status atual.
 *
 * Cópia de `DELIVERY_TRANSITIONS` (backend/src/domain/customer-order-state.ts).
 *
 * Duplicar é perigoso — e ainda assim é a menor das opções: o backend valida
 * com `canTransitionDelivery` e devolve 409 para o que não estiver na máquina,
 * então o pior caso desta lista desatualizada é o gerente escolher uma opção e
 * ver o erro. O contrário (mostrar TODOS os status e deixar o servidor
 * recusar) faz o gerente descobrir a regra por tentativa, uma por vez. Quando o
 * backend ganhar transições novas, esta é a lista a atualizar — o teste
 * `deliveryTransitions` abaixo é o alarme que avisa.
 */
export const DELIVERY_TRANSITIONS = {
  awaiting_courier: [
    { value: "out_for_delivery", label: "A caminho" },
    { value: "cancelled", label: "Cancelar entrega" },
  ],
  out_for_delivery: [
    { value: "delivered", label: "Marcar entregue" },
    { value: "failed", label: "Marcar falha" },
    { value: "cancelled", label: "Cancelar entrega" },
  ],
  failed: [{ value: "cancelled", label: "Cancelar entrega" }],
  // Terminais: sem saída. `delivered` não volta atrás de propósito — entregue
  // é o fim do registro operacional.
  delivered: [],
  cancelled: [],
};

/** O que o gerente pode marcar a partir deste status. */
export function allowedTransitions(status) {
  return DELIVERY_TRANSITIONS[status] ?? [];
}

/**
 * Este status precisa de motivo?
 *
 * Cancelar e registrar falha guardam o texto que o cliente recebe na
 * notificação, então "sem motivo" não é opção — a tela pede antes de enviar.
 */
export function statusNeedsReason(status) {
  return status === "cancelled" || status === "failed";
}
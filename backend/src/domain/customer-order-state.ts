// Máquina de estado do pedido do cliente — fonte única da verdade da
// "etapa do pedido" exibida pro cliente (página pública /pedido, WhatsApp).
// Os 3 eixos de status do schema (orders.status, order_item.status,
// delivery.status) são internos; o cliente consome um estado canônico
// derivado daqui. Módulo puro — sem imports de infra/db; a orquestração
// de persistência/eventos vive na camada application (ver
// self-service/customer-stage.ts).
//
// received → preparing → ready → out_for_delivery → delivered
//     ↘ cancelled            ↘ failed (terminais)

export type CustomerStage =
  | "received"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "failed"
  | "cancelled";

export type CustomerStageMeta = { label: string; terminal: boolean };

export const CUSTOMER_STAGES: Record<CustomerStage, CustomerStageMeta> = {
  received: { label: "Pedido recebido", terminal: false },
  preparing: { label: "Preparando", terminal: false },
  ready: { label: "Pronto", terminal: false },
  out_for_delivery: { label: "Saiu para entrega", terminal: false },
  delivered: { label: "Entregue", terminal: true },
  failed: { label: "Problema na entrega", terminal: true },
  cancelled: { label: "Cancelado", terminal: true },
};

// Ordem canônica de progresso — failed/cancelled são terminais fora dela
// (a UI mostra alerta próprio, sem etapa atual).
const PROGRESS_ORDER: CustomerStage[] = ["received", "preparing", "ready", "out_for_delivery", "delivered"];

// Entradas soltas — a função pura trabalha com o mínimo que precisa
// (qualquer forma serializada dos 3 eixos).
export type StageOrder = { status: string };
export type StageItem = { status: string };
export type StageDelivery = { status: string } | null;

export function deriveCustomerStage(order: StageOrder, items: StageItem[], delivery: StageDelivery): CustomerStage {
  // 1. Cancelamento encerra tudo — fonte: orders.status (manager ou cliente
  //    cancelou; a delivery, se existir, vira "cancelled" junto).
  if (order.status === "cancelled") return "cancelled";

  // 2. Eixo delivery tem precedência no fluxo de entrega — incluindo
  //    "out_for_delivery" sobre um fechamento manual (comanda fechada mas
  //    entrega ainda em rota: o cliente precisa ver "Saiu para entrega").
  if (delivery) {
    if (delivery.status === "failed") return "failed";
    if (delivery.status === "cancelled") return "cancelled"; // defensivo — cancelamento já cobre
    if (delivery.status === "delivered") return "delivered";
    if (delivery.status === "out_for_delivery") return "out_for_delivery";
  }

  // 3. Pedido resolvido sem delivery ativa (iFood concluded, fechamento manual).
  if (order.status === "closed") return "delivered";

  // 4. Eixo de itens — order_item.status é ["ordered","ready","delivered",
  //    "cancelled"] (não existe "sending": a cozinha marca direto "ready").
  //    "ordered" = nem começou a preparo; mistura de ordered+ready = em
  //    preparo. Modo sem cozinha nasce itens "delivered" → stage "ready"
  //    direto (paridade de configuração).
  const activeItems = items.filter((i) => i.status !== "cancelled");
  if (activeItems.length === 0) return "received";
  if (activeItems.every((i) => i.status === "ordered")) return "received";
  if (activeItems.every((i) => i.status === "ready" || i.status === "delivered")) return "ready";
  return "preparing";
}

export type StageTimelineEntry = { stage: CustomerStage; label: string; done: boolean; current: boolean };

// Timeline canônica pra UI — done/current derivados do stage; terminais
// fora da ordem de progresso não marcam etapa atual.
export function stageTimeline(stage: CustomerStage): StageTimelineEntry[] {
  const currentIdx = PROGRESS_ORDER.indexOf(stage);
  return PROGRESS_ORDER.map((s, i) => ({
    stage: s,
    label: CUSTOMER_STAGES[s].label,
    done: currentIdx >= 0 && i < currentIdx,
    current: currentIdx >= 0 && i === currentIdx,
  }));
}

// ---------- Máquina declarativa do eixo delivery ----------

export type DeliveryStatus = "awaiting_courier" | "out_for_delivery" | "delivered" | "failed" | "cancelled";

// Transições válidas — regra única usada por dispatch/deliver/fail
// (delivery.usecases.ts), conclusão/cancelamento iFood (status-pushback.ts)
// e propagação de cancelamento (cancelOrderUsecase / cancel-order.usecase).
// "out_for_delivery → cancelled" existe só pra cancelamento manager-driven
// (comanda cancelada com entregador em rota); o cliente NÃO cancela nesse
// estágio (CUSTOMER_CANCELLABLE_STAGES restringe o endpoint público).
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  awaiting_courier: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "failed", "cancelled"],
  delivered: [],
  failed: ["cancelled"],
  cancelled: [],
};

export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

// Stages em que o cliente pode cancelar o pedido: antes do entregador sair
// em rota, ou quando a entrega já falhou e o pedido continua aberto.
export const CUSTOMER_CANCELLABLE_STAGES: CustomerStage[] = ["received", "preparing", "ready", "failed"];

export function isCustomerCancellable(stage: CustomerStage): boolean {
  return CUSTOMER_CANCELLABLE_STAGES.includes(stage);
}

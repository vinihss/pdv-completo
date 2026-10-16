import { request } from "@/shared/api/http";

// Central de alertas (migration 0004). O recorte por papel é do BACKEND
// (`audience_roles`): o client pede a lista e recebe só o que o seu papel
// deveria ouvir — por isso não existe filtro de papel aqui.
//
// `unread` é o número do badge (total do papel, não da janela) e vem sempre
// sem o `unread_only` da lista: filtrar a lista não pode zerar o sino.

export function listAlerts({ limit, unreadOnly } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (unreadOnly) params.set("unread_only", "true");
  const qs = params.toString();
  return request("GET", `/alerts${qs ? `?${qs}` : ""}`);
}

/**
 * Marca como lido. Com `orderId` é a regra "a tela daquela comanda foi vista,
 * desmarca"; sem ele, o "marcar todas como lidas" do sino. É idempotente —
 * o backend só conta o que mudou, então clicar duas vezes não faz mal.
 */
export function markAlertsRead(orderId) {
  return request("POST", "/alerts/mark-read", orderId ? { orderId } : {});
}

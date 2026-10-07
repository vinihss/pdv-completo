import { toDate } from "@/shared/lib/format";

/**
 * Tempo decorrido no card, em português de quem está na rua.
 *
 * O dado já vem no payload (`createdAt` e `dispatchedAt`) — o que não existia
 * era a leitura. O entregador precisa de duas respostas: "há quanto tempo essa
 * parada está esperando" (a fila) e "já estou com essa entrega há quanto
 * tempo" (a que está em rota).
 */

/**
 * Limite de alerta, em minutos, por tipo de card. Constante local, e não
 * `store_settings`: os campos que existem lá são da cozinha, e o valor da rota
 * depende do bairro/restaurante — quem tem que calibrar isso é o dono, não o
 * PDV.
 */
export const QUEUE_URGENT_MIN = 20;
export const IN_TRANSIT_URGENT_MIN = 30;

/** "23 min", "1 h 05", "menos de 1 min". */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return "";
  const total = Math.max(0, Math.round(minutes));
  if (total < 1) return "menos de 1 min";
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${h} h` : `${h} h ${String(rest).padStart(2, "0")}`;
}

export function elapsedMinutes(ts, now = Date.now()) {
  const d = ts ? toDate(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.max(0, (now - d.getTime()) / 60000);
}

/**
 * Texto do cronômetro do card, ou `null` quando não há carimbo (payload velho,
 * ou entrega sem `createdAt`) — quem chama esconde a linha inteira em vez de
 * mostrar "parada há NaN min".
 *
 * `now` entra por parâmetro (e não por `Date.now()` dentro) para o tick da tela
 * ser explícito e o teste não depender de relógio.
 */
export function elapsedInfo(delivery, now = Date.now()) {
  if (!delivery) return null;
  if (delivery.status === "awaiting_courier") {
    const minutes = elapsedMinutes(delivery.createdAt, now);
    if (minutes === null) return null;
    return {
      minutes,
      urgent: minutes >= QUEUE_URGENT_MIN,
      text: `parada há ${formatDuration(minutes)}`,
    };
  }
  if (delivery.status === "out_for_delivery") {
    const minutes = elapsedMinutes(delivery.dispatchedAt ?? delivery.createdAt, now);
    if (minutes === null) return null;
    return {
      minutes,
      urgent: minutes >= IN_TRANSIT_URGENT_MIN,
      text: `saiu há ${formatDuration(minutes)}`,
    };
  }
  return null;
}

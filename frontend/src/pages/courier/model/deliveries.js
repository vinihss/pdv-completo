import { toDate } from "@/shared/lib";

/**
 * Uma entrega vira UMA das três seções da tela, nunca uma lista única.
 *
 * A versão anterior desenhava todas as abertas em ordem de `createdAt` (é o
 * que o backend devolve) com o mesmo card: a que ele já despachou —
 * `out_for_delivery`, a que ele está fazendo agora — podia ficar no meio da
 * lista, e ele lia 4 cards na rua para achar a ativa. Aqui o status é a
 * estrutura da tela: o que está em rota sobe, a fila desce.
 *
 * `delivered`/`cancelled` não caem em nenhuma seção — é o mesmo corte de
 * `isOpenDelivery` (entregue já foi, cancelado deixou de ser pedido) e a
 * entrega resolvida enterra a próxima atrás dela.
 */
export function groupDeliveries(list) {
  const safe = Array.isArray(list) ? list.filter(Boolean) : [];
  return {
    // Em rota: a mais antiga em trânsito é a HERO (é a próxima parada de
    // verdade). Sobrar mais de uma em trânsito é possível (o gerente atribui
    // duas e o entregador despacha as duas), então as excedentes continuam
    // visíveis como cards compactos — perder a segunda seria pior que
    // duplicar um card.
    active: oldestFirst(safe.filter((d) => d.status === "out_for_delivery"), (d) => d.dispatchedAt ?? d.createdAt),
    // Fila: mais antiga primeiro, que é a ordem em que dá para sair.
    queue: oldestFirst(safe.filter((d) => d.status === "awaiting_courier"), (d) => d.createdAt),
    // Problemas: a mais recente primeiro (é a que o gerente vai resolver
    // primeiro). Sem carimbo de tempo — a tela do entregador não tem
    // `failedAt` no payload — a ordenação usa `createdAt`, que existe.
    failed: newestFirst(safe.filter((d) => d.status === "failed"), (d) => d.createdAt),
  };
}

function timeOf(delivery, pick) {
  const raw = pick?.(delivery);
  const d = raw ? toDate(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
}

function oldestFirst(items, pick) {
  return [...items].sort((a, b) => timeOf(a, pick) - timeOf(b, pick));
}

function newestFirst(items, pick) {
  return [...items].sort((a, b) => timeOf(b, pick) - timeOf(a, pick));
}
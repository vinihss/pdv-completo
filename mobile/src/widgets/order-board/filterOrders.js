// Filtros e ordenação da lista de comandas do garçom — extraídos do
// OrderListScreen do web para serem testáveis sem render. Mesmas regras:
// ordem aberta antes de fechada, e dentro do mesmo status pelo horário de
// abertura/fechamento (mais recente primeiro).

import { orderHasReady, orderLabel } from "@/entities/order";

export const FILTERS = [
  { id: "all", label: "Todas" },
  { id: "open", label: "Abertas" },
  { id: "closed", label: "Fechadas" },
];

export function visibleChips(kitchenEnabled, usesTables) {
  return [
    ...FILTERS,
    ...(kitchenEnabled ? [{ id: "ready", label: "Com pronto" }] : []),
    ...(usesTables ? [{ id: "table", label: "Mesa" }] : []),
    { id: "customer", label: "Cliente" },
  ];
}

export function filterOrders(orders, { filter = "all", search = "" } = {}) {
  const filtered = orders.filter((o) => {
    if (filter === "open" && o.status !== "open") return false;
    if (filter === "closed" && o.status !== "closed") return false;
    if (filter === "ready" && !orderHasReady(o)) return false;
    if (filter === "table" && !o.tableId) return false;
    if (filter === "customer" && o.tableId) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!orderLabel(o).toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    const aTs = a.status === "closed" ? a.closedAt : a.openedAt;
    const bTs = b.status === "closed" ? b.closedAt : b.openedAt;
    return (bTs ?? "").localeCompare(aTs ?? "");
  });
}

export function emptyMessage(filter) {
  if (filter === "closed") return "Nenhuma comanda fechada encontrada.";
  if (filter === "all") return "Nenhuma comanda encontrada.";
  return "Nenhuma comanda aberta encontrada.";
}
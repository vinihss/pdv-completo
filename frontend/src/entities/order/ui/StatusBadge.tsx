import React from "react";

const STATUS_LABEL = {
  ordered: "Em preparo",
  ready: "Pronto",
  delivered: "Entregue",
  cancelled: "Cancelado",
};
const STATUS_CLASS = {
  ordered: "bg-surface-overlay text-text-secondary",
  ready: "bg-success text-primary-foreground",
  delivered: "bg-surface-overlay text-text-muted",
  // cancelOrder marca como "cancelled" todo item ainda não entregue
  // (order.usecases.ts) — e orderTotal já os exclui da soma.
  cancelled: "bg-destructive/15 text-destructive",
};

export default function StatusBadge({ status }) {
  return (
    <span
      className={`text-[11px] font-bold px-2 py-1 rounded-full ${STATUS_CLASS[status] ?? STATUS_CLASS.ordered}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

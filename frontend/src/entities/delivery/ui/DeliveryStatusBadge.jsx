import React from "react";

const DELIVERY_STATUS_LABEL = { awaiting_courier: "Aguardando", out_for_delivery: "A caminho", delivered: "Entregue", failed: "Falhou" };
const DELIVERY_STATUS_CLASS = {
  awaiting_courier: "bg-amber-500/15 text-amber-400",
  out_for_delivery: "bg-sky-500/15 text-sky-400",
  delivered: "bg-emerald-500 text-emerald-950",
  failed: "bg-red-500/15 text-red-400",
};

export default function DeliveryStatusBadge({ status, className = "" }) {
  return (
    <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${DELIVERY_STATUS_CLASS[status] ?? DELIVERY_STATUS_CLASS.awaiting_courier} ${className}`}>
      {DELIVERY_STATUS_LABEL[status] ?? status}
    </span>
  );
}

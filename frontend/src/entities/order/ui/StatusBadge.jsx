import React from "react";

const STATUS_LABEL = { ordered: "Em preparo", ready: "Pronto", delivered: "Entregue" };
const STATUS_CLASS = {
  ordered: "bg-stone-700 text-stone-300",
  ready: "bg-emerald-500 text-emerald-950",
  delivered: "bg-stone-800 text-stone-500",
};

export default function StatusBadge({ status }) {
  return (
    <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${STATUS_CLASS[status] ?? STATUS_CLASS.ordered}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

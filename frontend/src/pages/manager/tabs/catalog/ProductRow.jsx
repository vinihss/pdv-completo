import React from "react";
import { Package, Eye, EyeOff, UtensilsCrossed } from "lucide-react";
import { formatBRL } from "@/shared/lib";

export function ProductRow({ product: p, categoryName, onOpen, onToggleActive, ifoodIntegrationEnabled = false, kitchenEnabled = true }) {
  return (
    <button
      onClick={onOpen}
      className={`w-full flex items-center justify-between text-left px-3 py-2.5 rounded-xl ${p.active ? "bg-stone-800/60" : "bg-stone-800/20 opacity-50"}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {p.imagePath ? (
          <img src={p.imagePath} alt={p.name} className="w-10 h-10 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-stone-900 border border-stone-700 flex items-center justify-center text-stone-600 shrink-0">
            <Package size={18} />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium flex items-center gap-1.5">
            {p.name}
            {!p.active && (
              <span className="text-[10px] font-bold text-stone-500 bg-stone-700/60 rounded-full px-1.5 py-0.5">Indisponível</span>
            )}
            {ifoodIntegrationEnabled && p.ifoodEnabled && (
              <span className="flex items-center gap-0.5 text-[10px] font-bold text-red-400 bg-red-500/10 rounded-full px-1.5 py-0.5 shrink-0">
                <UtensilsCrossed size={10} /> iFood
              </span>
            )}
            {p.trackStock && (
              <span
                className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0 ${
                  p.quantity <= 0 ? "bg-red-500/15 text-red-400" : p.low ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"
                }`}
              >
                {p.quantity <= 0 ? "Sem estoque" : p.low ? `Estoque baixo (${p.quantity})` : `Estoque ${p.quantity}`}
              </span>
            )}
          </div>
          <div className="text-stone-500 text-xs truncate">
            {categoryName}
            {kitchenEnabled && p.kitchenGroupName ? ` · ${p.kitchenGroupName}` : ""}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-emerald-400 text-sm font-semibold">{formatBRL(p.price)}</span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onToggleActive();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              onToggleActive();
            }
          }}
          title={p.active ? "Desativar para venda" : "Ativar para venda"}
          className={`p-1 rounded-lg ${p.active ? "text-emerald-400 hover:text-amber-400" : "text-stone-600 hover:text-emerald-400"}`}
        >
          {p.active ? <Eye size={16} /> : <EyeOff size={16} />}
        </span>
      </div>
    </button>
  );
}
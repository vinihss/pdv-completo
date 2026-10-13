import React from "react";
import { Package, Eye, EyeOff, UtensilsCrossed } from "lucide-react";
import { formatBRL } from "@/shared/lib";
import { assetUrl } from "@/shared/lib/server";

export function ProductRow({ product: p, categoryName, onOpen, onToggleActive, ifoodIntegrationEnabled = false, kitchenEnabled = true }) {
  return (
    <button
      onClick={onOpen}
      className={`w-full flex items-center justify-between text-left px-3 py-2.5 rounded-xl ${p.active ? "bg-surface-overlay/60" : "bg-surface-overlay/20 opacity-50"}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {p.imagePath ? (
          <img src={assetUrl(p.imagePath)} alt={p.name} className="w-10 h-10 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-surface border border-border flex items-center justify-center text-text-muted shrink-0">
            <Package size={18} />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium flex items-center gap-1.5">
            {p.name}
            {!p.active && (
              <span className="text-[10px] font-bold text-text-muted bg-surface-overlay/60 rounded-full px-1.5 py-0.5">Indisponível</span>
            )}
            {ifoodIntegrationEnabled && p.ifoodEnabled && (
              <span className="flex items-center gap-0.5 text-[10px] font-bold text-destructive bg-destructive/10 rounded-full px-1.5 py-0.5 shrink-0">
                <UtensilsCrossed size={10} /> iFood
              </span>
            )}
            {p.trackStock && (
              <span
                className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0 ${
                  p.quantity <= 0 ? "bg-destructive/15 text-destructive" : p.low ? "bg-primary/15 text-primary" : "bg-success/15 text-success"
                }`}
              >
                {p.quantity <= 0 ? "Sem estoque" : p.low ? `Estoque baixo (${p.quantity})` : `Estoque ${p.quantity}`}
              </span>
            )}
          </div>
          <div className="text-text-muted text-xs truncate">
            {categoryName}
            {kitchenEnabled && p.kitchenGroupName ? ` · ${p.kitchenGroupName}` : ""}
          </div>
          {p.description && (
            <div className="text-text-secondary text-xs line-clamp-2 leading-snug">
              {p.description}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-success text-sm font-semibold">{formatBRL(p.price)}</span>
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
          className={`p-1 rounded-lg ${p.active ? "text-success hover:text-primary" : "text-text-muted hover:text-success"}`}
        >
          {p.active ? <Eye size={16} /> : <EyeOff size={16} />}
        </span>
      </div>
    </button>
  );
}
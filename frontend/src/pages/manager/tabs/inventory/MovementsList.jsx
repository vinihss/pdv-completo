import React, { useState, useEffect } from "react";
import { X, ArrowDownCircle, ArrowUpCircle, RotateCcw, Scale } from "lucide-react";
import { listStockMovements } from "@/entities/stock";
import { formatDateTime } from "@/shared/lib";

const TYPE_META = {
  sale: { label: "Venda", icon: ArrowDownCircle, color: "text-red-400" },
  refund: { label: "Estorno", icon: RotateCcw, color: "text-sky-400" },
  purchase: { label: "Compra", icon: ArrowUpCircle, color: "text-emerald-400" },
  adjustment: { label: "Ajuste", icon: Scale, color: "text-amber-400" },
};

// Histórico do ledger (fonte da verdade do estoque): cada linha soma no
// saldo; venda/estorno vêm do fluxo de comandas, compra/ajuste do gerente.
export default function MovementsList({ productId, productName, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listStockMovements(productId ? { product_id: productId, limit: 100 } : { limit: 100 })
      .then((r) => setRows(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [productId]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-md bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">Movimentos{productName ? ` · ${productName}` : ""}</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>

        {loading ? (
          <div className="text-stone-600 text-center py-10 text-sm">Carregando…</div>
        ) : (
          <div className="space-y-2">
            {rows.map((m) => {
              const meta = TYPE_META[m.type] ?? TYPE_META.adjustment;
              const Icon = meta.icon;
              return (
                <div key={m.id} className="bg-stone-800/60 rounded-xl px-3 py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2.5">
                    <Icon size={16} className={`shrink-0 ${meta.color}`} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">
                        {meta.label}
                        <span className="text-stone-500 font-normal"> · {productName ? "" : m.productName}</span>
                      </div>
                      <div className="text-stone-500 text-[11px] truncate">
                        {formatDateTime(m.createdAt)} · {m.userName}
                        {m.note ? ` · ${m.note}` : ""}
                      </div>
                    </div>
                  </div>
                  <span className={`text-sm font-bold shrink-0 ${m.quantityDelta > 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {m.quantityDelta > 0 ? "+" : ""}{m.quantityDelta}
                  </span>
                </div>
              );
            })}
            {rows.length === 0 && <div className="text-stone-600 text-center py-10 text-sm">Nenhum movimento registrado.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
import React from "react";
import { X, Trash2 } from "lucide-react";
import { variationsText } from "@/entities/order";
import { formatBRL } from "@/shared/lib";

export default function ReviewCartModal({ lines, total, onClose, onRemoveLine, onChangeNotes, onConfirm }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 max-h-[85vh] flex flex-col fade-up">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h3 className="font-display text-lg font-bold">Revisar itens</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-2 mb-4">
          {Object.entries(lines).map(([, line], idx) => {
            const key = line.product.id + JSON.stringify(line.selectedVariations);
            const variation = variationsText(line.selectedVariations);
            return (
              <div key={key ?? idx} className="bg-stone-800/60 rounded-xl px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">{line.quantity}× {line.product.name}</div>
                    {variation && <div className="text-stone-500 text-xs">{variation}</div>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-emerald-400 text-sm font-semibold">{formatBRL(line.product.price * line.quantity)}</span>
                    <button onClick={() => onRemoveLine(key)} className="text-stone-600 hover:text-red-400">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <input
                  value={line.notes ?? ""}
                  onChange={(e) => onChangeNotes(key, e.target.value)}
                  placeholder="Observações (ex.: sem cebola, ponto mal passado)"
                  className="mt-2 w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-xs outline-none focus:border-amber-500/50"
                />
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between mb-4 pt-3 border-t border-stone-800 shrink-0">
          <span className="text-stone-400 text-sm">Total</span>
          <span className="font-display text-lg font-bold text-emerald-400">{formatBRL(total)}</span>
        </div>
        <button
          onClick={onConfirm}
          className="w-full bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors shrink-0"
        >
          Confirmar lançamento
        </button>
      </div>
    </div>
  );
}
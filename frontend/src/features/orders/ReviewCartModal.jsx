import React from "react";
import { Trash2 } from "lucide-react";
import { variationsText } from "@/entities/order";
import { formatBRL } from "@/shared/lib";
import { Modal } from "@/shared/components";

export default function ReviewCartModal({ lines, total, onClose, onRemoveLine, onChangeNotes, onConfirm }) {
  return (
    <Modal
      title="Revisar itens"
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-stone-400 text-sm">Total</span>
            <span className="font-display text-lg font-bold text-emerald-400">{formatBRL(total)}</span>
          </div>
          <button
            onClick={onConfirm}
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors"
          >
            Confirmar lançamento
          </button>
        </>
      }
    >
      <div className="p-5 space-y-2">
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
                  <button onClick={() => onRemoveLine(key)} className="text-stone-600 hover:text-red-400" aria-label={`Remover ${line.product.name}`}>
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
    </Modal>
  );
}

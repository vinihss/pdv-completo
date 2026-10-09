import React, { useState } from "react";
import { Pencil, Check, Trash2, Minus, Plus } from "lucide-react";
import { variationsText } from "@/entities/order";
import { formatBRL } from "@/shared/lib";
import { Modal } from "@/shared/components";

// Rótulo explícito com a quantidade do lote: "Enviar 4 itens para a cozinha"
// (ou "Confirmar 4 itens" quando a loja não usa cozinha). Evita o genérico
// "Confirmar lançamento" que não dizia o que ia acontecer nem quantos itens.
function confirmLabel(count, kitchenEnabled) {
  if (count == null) return "Confirmar lançamento";
  const noun = count === 1 ? "item" : "itens";
  return kitchenEnabled ? `Enviar ${count} ${noun} para a cozinha` : `Confirmar ${count} ${noun}`;
}

export default function ReviewCartModal({
  lines,
  total,
  count,
  kitchenEnabled,
  onClose,
  onRemoveLine,
  onChangeNotes,
  onChangeQty,
  onConfirm,
}) {
  const [editingNotes, setEditingNotes] = useState(null); // key da linha sendo editada

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
            {confirmLabel(count, kitchenEnabled)}
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
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{line.product.name}</div>
                  {variation && <div className="text-stone-500 text-xs truncate">{variation}</div>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-emerald-400 text-sm font-semibold">{formatBRL(line.product.price * line.quantity)}</span>
                  <button onClick={() => onRemoveLine(key)} className="text-stone-600 hover:text-red-400 p-1" aria-label={`Remover ${line.product.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Controles − / + com a quantidade no meio. Áreas de toque de
                  36px (w-9 h-9); `−` desabilita em 1 porque remover segue na
                  lixeira, nunca por decremento acidental. */}
              <div className="mt-2 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onChangeQty(key, -1)}
                  disabled={line.quantity <= 1}
                  aria-label={`Diminuir ${line.product.name}`}
                  className="w-9 h-9 flex items-center justify-center rounded-lg bg-stone-900 border border-stone-700 text-stone-200 transition-colors hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Minus size={16} />
                </button>
                <span className="w-8 text-center text-sm font-semibold tabular-nums">{line.quantity}</span>
                <button
                  type="button"
                  onClick={() => onChangeQty(key, +1)}
                  aria-label={`Aumentar ${line.product.name}`}
                  className="w-9 h-9 flex items-center justify-center rounded-lg bg-stone-900 border border-stone-700 text-stone-200 transition-colors hover:bg-stone-700"
                >
                  <Plus size={16} />
                </button>
              </div>

              {/* Trigger: pencil + "observações" texto */}
              {editingNotes !== key ? (
                <div
                  onClick={() => setEditingNotes(key)}
                  className="mt-2 flex items-center gap-2 cursor-pointer select-none"
                  title="Adicionar observação"
                >
                  <Pencil size={14} className="text-stone-400" />
                  <span className="text-xs text-stone-400">Observações</span>
                </div>
              ) : (
                /* Campo de observação aberto */
                <>
                  <input
                    value={line.notes ?? ""}
                    onChange={(e) => onChangeNotes(key, e.target.value)}
                    placeholder="Observações (ex.: sem cebola, ponto mal passado)"
                    className="mt-2 w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-xs outline-none focus:border-amber-500/50"
                  />
                  <div className="mt-1 flex items-center gap-1">
                    <Check size={12} className="text-emerald-400 hover:text-emerald-500" onClick={() => setEditingNotes(null)} />
                    <span className="text-xs text-stone-400">Confirmar</span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

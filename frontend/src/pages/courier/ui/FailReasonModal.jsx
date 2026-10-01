import React from "react";
import { Modal, inputClass } from "@/shared/components";
import { FAIL_PRESETS } from "../model/failPresets.js";
import { shortOrderId } from "../model/orderView.js";

/**
 * Falha da entrega em 1 toque.
 *
 * O `reason` é obrigatório na prática (`PATCH /courier/deliveries/:id/fail` com
 * `z.string().min(1)`) e é o texto que o cliente recebe na notificação — mas
 * digitar na rua, de luva, com uma mão só, é a pior interação possível. Os
 * presets preenchem em 1 toque e o campo continua editável para o que não
 * couber neles ("portão fechado, vizinho não sabe").
 *
 * `Modal` (não overlay próprio) por regra do repo: sobreposição tem dono.
 */
export default function FailReasonModal({ delivery, reason, onChange, onClose, onConfirm, busy }) {
  const orderRef = shortOrderId(delivery?.orderId);
  const canConfirm = reason.trim().length > 0 && !busy;

  return (
    <Modal
      title="Problema na entrega"
      subtitle={orderRef ?? undefined}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="h-12 px-4 rounded-xl border border-stone-700 text-stone-300 text-sm font-semibold shrink-0"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className="h-12 flex-1 rounded-xl bg-red-600 text-white text-sm font-bold disabled:opacity-40 active:scale-[0.99]"
          >
            Confirmar falha
          </button>
        </div>
      }
    >
      <div className="p-4 space-y-4">
        <div>
          <p className="text-stone-400 text-sm font-semibold mb-2.5">O que aconteceu?</p>
          <div className="flex flex-wrap gap-2">
            {FAIL_PRESETS.map((preset) => {
              const selected = reason === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => onChange(preset)}
                  aria-pressed={selected}
                  className={`h-11 px-3.5 rounded-xl border text-sm font-semibold ${
                    selected
                      ? "border-amber-500 bg-amber-500/15 text-amber-300"
                      : "border-stone-700 bg-stone-900 text-stone-300 hover:border-stone-600"
                  }`}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label htmlFor="courier-fail-reason" className="text-stone-400 text-xs font-medium mb-1.5 block">
            Detalhe (opcional, substitui o motivo escolhido)
          </label>
          <input
            id="courier-fail-reason"
            value={reason}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Ex.: portão fechado, vizinho não sabe o número"
            className={inputClass}
          />
        </div>

        <p className="text-xs text-stone-500 leading-snug">
          O motivo vai para o cliente e para o gerente. Depois disso o gerente assume a entrega.
        </p>
      </div>
    </Modal>
  );
}
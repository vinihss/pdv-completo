import React, { useState } from "react";
import { Field, inputClass, Modal } from "@/shared/components";
import { formatBRL } from "@/shared/lib";


export default function CloseCashDrawerModal({ expected, onClose, onConfirm }) {
  const [counted, setCounted] = useState(expected.toFixed(2));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const countedValue = Number(counted);
  const difference = Number.isNaN(countedValue) ? null : Math.round((countedValue - expected) * 100) / 100;

  async function handleSubmit() {
    if (difference === null || countedValue < 0) return;
    setSaving(true);
    const ok = await onConfirm(countedValue, note.trim() || undefined);
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <Modal
      title="Fechar caixa"
      onClose={onClose}
      footer={
        <button onClick={handleSubmit} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl">
          {saving ? "Fechando…" : "Fechar caixa"}
        </button>
      }
    >
      <div className="p-5">
        <div className="flex items-center justify-between text-sm bg-stone-950 border border-stone-800 rounded-xl px-3 py-2.5 mb-4">
          <span className="text-stone-400">Esperado</span>
          <span className="font-semibold text-emerald-400">{formatBRL(expected)}</span>
        </div>
        <Field label="Contado (R$)">
          <input type="number" inputMode="decimal" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} className={inputClass} autoFocus />
        </Field>
        {difference !== null && difference !== 0 && (
          <div className={`text-xs mt-2 font-semibold ${difference > 0 ? "text-emerald-400" : "text-red-400"}`}>
            Diferença: {difference > 0 ? "+" : ""}{formatBRL(difference)}
          </div>
        )}
        <div className="my-3">
          <Field label="Observação da conferência (opcional)">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={difference && difference !== 0 ? "Motivo da variação" : "Ex.: separado fundo de quinta"}
              className={inputClass}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
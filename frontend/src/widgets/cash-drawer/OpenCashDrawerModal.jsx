import React, { useState } from "react";
import { X } from "lucide-react";
import { Field, inputClass } from "@/shared/components";

export default function OpenCashDrawerModal({ onClose, onConfirm }) {
  const [openingAmount, setOpeningAmount] = useState("0");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const amount = Number(openingAmount);
    if (Number.isNaN(amount) || amount < 0) return;
    setSaving(true);
    const ok = await onConfirm({
      openingAmount: Math.round(amount * 100) / 100,
      note: note.trim() || undefined,
    });
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-xs bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">Abrir caixa</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <Field label="Fundo inicial (R$)">
          <input type="number" inputMode="decimal" min="0" step="0.01" value={openingAmount} onChange={(e) => setOpeningAmount(e.target.value)} className={inputClass} autoFocus />
        </Field>
        <div className="my-3">
          <Field label="Observação (opcional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: fundo para troco" className={inputClass} />
          </Field>
        </div>
        <button onClick={handleSubmit} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl">
          {saving ? "Abrindo…" : "Abrir caixa"}
        </button>
      </div>
    </div>
  );
}
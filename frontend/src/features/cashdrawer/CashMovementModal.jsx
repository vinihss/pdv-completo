import React, { useState } from "react";
import { X } from "lucide-react";
import { Field, inputClass } from "@/shared/components";

const META = {
  sangria: { title: "Sangria", desc: "Retirada de dinheiro do caixa.", button: "Registrar sangria" },
  suprimento: { title: "Suprimento", desc: "Reforço de dinheiro no caixa.", button: "Registrar suprimento" },
};

export default function CashMovementModal({ type, onClose, onConfirm }) {
  const meta = META[type];
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const value = Number(amount);
    if (Number.isNaN(value) || value <= 0) return;
    setSaving(true);
    const ok = await onConfirm({
      amount: Math.round(value * 100) / 100,
      note: note.trim() || undefined,
    });
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-xs bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-lg font-bold">{meta.title}</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="text-stone-500 text-xs mb-4">{meta.desc}</div>
        <Field label="Valor (R$)">
          <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} autoFocus />
        </Field>
        <div className="my-3">
          <Field label="Observação (opcional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motivo" className={inputClass} />
          </Field>
        </div>
        <button onClick={handleSubmit} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl">
          {saving ? "Registrando…" : meta.button}
        </button>
      </div>
    </div>
  );
}
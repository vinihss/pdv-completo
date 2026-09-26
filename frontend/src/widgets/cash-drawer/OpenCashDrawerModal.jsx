import React, { useState } from "react";
import { Field, inputClass, Modal } from "@/shared/components";

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
    <Modal
      title="Abrir caixa"
      onClose={onClose}
      footer={
        <button onClick={handleSubmit} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl">
          {saving ? "Abrindo…" : "Abrir caixa"}
        </button>
      }
    >
      <div className="p-5">
        <Field label="Fundo inicial (R$)">
          <input type="number" inputMode="decimal" min="0" step="0.01" value={openingAmount} onChange={(e) => setOpeningAmount(e.target.value)} className={inputClass} autoFocus />
        </Field>
        <div className="my-3">
          <Field label="Observação (opcional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: fundo para troco" className={inputClass} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
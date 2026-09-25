import React, { useState } from "react";
import { X } from "lucide-react";
import { createSupplier } from "@/shared/api/purchase";
import { Field, inputClass } from "@/shared/components";

// Cadastro rápido de fornecedor pelo gerente.
export default function SupplierModal({ onClose, onSaved, showToast }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [taxId, setTaxId] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim()) {
      showToast("Informe o nome do fornecedor.", "error");
      return;
    }
    setSaving(true);
    try {
      await createSupplier({ name: name.trim(), phone: phone.trim() || null, taxId: taxId.trim() || null });
      showToast("Fornecedor criado.", "success");
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">Novo fornecedor</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="space-y-3 mb-5">
          <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Distribuidora Bebidas" className={inputClass} /></Field>
          <Field label="Telefone (opcional)"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 99999-0000" className={inputClass} /></Field>
          <Field label="CNPJ / CPF (opcional)"><input value={taxId} onChange={(e) => setTaxId(e.target.value)} className={inputClass} /></Field>
        </div>
        <button onClick={handleSave} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl">
          {saving ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </div>
  );
}

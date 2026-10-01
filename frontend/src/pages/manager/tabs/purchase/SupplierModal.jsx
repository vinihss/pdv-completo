import React, { useState } from "react";
import { createSupplier } from "@/entities/stock";
import { maskCnpjCpf } from "@/shared/lib";
import { Field, inputClass, Modal } from "@/shared/components";

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
    <Modal
      title="Novo fornecedor"
      onClose={onClose}
      footer={
        <button type="submit" form="supplier-form" disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl">
          {saving ? "Salvando…" : "Salvar"}
        </button>
      }
    >
      <form id="supplier-form" noValidate onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="p-5 space-y-3">
        <Field label="Nome" required><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Distribuidora Bebidas" className={inputClass} /></Field>
        <Field label="Telefone (opcional)"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 99999-0000" className={inputClass} /></Field>
        <Field label="CNPJ / CPF (opcional)"><input value={taxId} onChange={(e) => setTaxId(maskCnpjCpf(e.target.value))} inputMode="numeric" className={inputClass} /></Field>
      </form>
    </Modal>
  );
}

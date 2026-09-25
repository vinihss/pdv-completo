import React, { useState } from "react";
import { X, Plus, Trash2, PackagePlus } from "lucide-react";
import { createPurchase } from "@/shared/api/purchase";
import { formatBRL, parseBRL, maskCurrencyInput } from "@/shared/lib";
import { Field, inputClass } from "@/shared/components";

let lineKey = 0;
const emptyLine = () => ({ key: `l${++lineKey}`, productId: "", quantity: "", unitCost: "", batchNo: "", expiryDate: "" });

// Registro de compra (documento multi-item): cada linha debita entrada no
// ledger e atualiza o custo médio móvel do produto no backend.
export default function NewPurchaseModal({ suppliers, products, onClose, onSaved, showToast }) {
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issuedOn, setIssuedOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([emptyLine()]);
  const [saving, setSaving] = useState(false);

  function updateLine(key, patch) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  }

  const total = lines.reduce((acc, l) => {
    const q = Number(l.quantity || 0);
    const c = parseBRL(l.unitCost);
    return acc + (q > 0 && c > 0 ? q * c : 0);
  }, 0);

  async function handleSave() {
    if (lines.some((l) => l.productId && Number(l.quantity) > 0 && l.unitCost === "")) {
      showToast("Informe o custo unitário de cada item (R$ 0,00 é válido).", "error");
      return;
    }
    const items = lines
      .filter((l) => l.productId && Number(l.quantity) > 0)
      .map((l) => ({
        productId: l.productId,
        quantity: Number(l.quantity),
        unitCost: parseBRL(l.unitCost),
        batchNo: l.batchNo.trim() || null,
        expiryDate: l.expiryDate || null,
      }));
    if (items.length === 0) {
      showToast("Adicione ao menos um item com produto e quantidade.", "error");
      return;
    }
    setSaving(true);
    try {
      await createPurchase({
        supplierId: supplierId || null,
        invoiceNumber: invoiceNumber.trim() || null,
        issuedOn: issuedOn || null,
        note: note.trim() || null,
        items,
      });
      showToast("Compra registrada — estoque e custo médio atualizados.", "success");
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-md bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">Nova compra</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="space-y-3 mb-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fornecedor">
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputClass}>
                <option value="">— Sem fornecedor —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Data">
              <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={inputClass} />
            </Field>
          </div>
          <Field label="Nº da nota / documento (opcional)">
            <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="Ex.: NF-1234" className={inputClass} />
          </Field>

          <div className="text-stone-400 text-xs font-medium pt-1">Itens</div>
          {lines.map((l) => (
            <div key={l.key} className="bg-stone-800/60 rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={l.productId}
                  onChange={(e) => updateLine(l.key, { productId: e.target.value })}
                  className="flex-1 bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-500/50"
                >
                  <option value="">Selecione o produto…</option>
                  {products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}
                </select>
                <button onClick={() => removeLine(l.key)} className="text-stone-500 hover:text-red-400 shrink-0"><Trash2 size={15} /></button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Field label={`Qtd.`}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={l.quantity}
                    onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                    placeholder="0"
                    className={inputClass}
                  />
                </Field>
                <Field label="Custo un.">
                  <input
                    inputMode="numeric"
                    value={l.unitCost}
                    onChange={(e) => updateLine(l.key, { unitCost: maskCurrencyInput(e.target.value) })}
                    placeholder="R$ 0,00"
                    className={inputClass}
                  />
                </Field>
                <Field label="Lote (opcional)">
                  <input
                    value={l.batchNo}
                    onChange={(e) => updateLine(l.key, { batchNo: e.target.value })}
                    placeholder="L1"
                    className={inputClass}
                  />
                </Field>
              </div>
            </div>
          ))}
          <button onClick={() => setLines((prev) => [...prev, emptyLine()])} className="flex items-center gap-1.5 text-amber-500 text-sm font-semibold">
            <Plus size={14} /> Adicionar item
          </button>

          <div className="flex items-center justify-between border-t border-stone-800 pt-3">
            <span className="text-stone-400 text-sm">Total da compra</span>
            <span className="font-display font-bold text-lg">{formatBRL(total)}</span>
          </div>
          <Field label="Observação (opcional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <button onClick={handleSave} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl flex items-center justify-center gap-2">
          <PackagePlus size={16} /> {saving ? "Registrando…" : "Registrar compra"}
        </button>
      </div>
    </div>
  );
}

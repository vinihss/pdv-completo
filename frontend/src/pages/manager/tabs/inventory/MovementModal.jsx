import React, { useState } from "react";
import { ArrowRightLeft, PlusCircle, MinusCircle } from "lucide-react";
import { registerStockMovement } from "@/entities/stock";
import { Field, inputClass, Modal } from "@/shared/components";

// Entrada de mercadoria (compra) ou ajuste de contagem (Δ sinalizado):
// - Compra: quantidade POSITIVA (só entra estoque);
// - Ajuste: + sobra de contagem, - perda/quebra (pode ser negativo).
// Sempre registrado como movimento auditável; idempotente via correlationId.
export default function MovementModal({ product, onClose, onSaved, showToast }) {
  const [type, setType] = useState("purchase");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const qty = Number(String(quantity).replace(",", "."));
    if (type === "purchase" && !(qty > 0)) {
      showToast("Informe a quantidade da entrada (maior que zero).", "error");
      return;
    }
    if (type === "adjustment" && qty === 0) {
      showToast("Ajuste de zero não faz sentido — informe a diferença.", "error");
      return;
    }
    setSaving(true);
    try {
      await registerStockMovement(product.productId, { type, quantity: qty, note: note.trim() || undefined });
      showToast(
        type === "purchase" ? `Entrada de ${qty} · ${product.name}` : `Ajuste de ${qty} · ${product.name}`,
        "success"
      );
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Estoque"
      subtitle={product.name}
      onClose={onClose}
      footer={
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl"
        >
          {saving ? "Registrando…" : type === "purchase" ? "Registrar entrada" : "Registrar ajuste"}
        </button>
      }
    >
      <div className="p-5">
        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            onClick={() => setType("purchase")}
            className={`flex flex-col items-center gap-1 rounded-xl border py-3 text-sm font-semibold ${
              type === "purchase" ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-400" : "bg-stone-800 border-stone-700 text-stone-400"
            }`}
          >
            <PlusCircle size={18} /> Entrada (compra)
          </button>
          <button
            onClick={() => setType("adjustment")}
            className={`flex flex-col items-center gap-1 rounded-xl border py-3 text-sm font-semibold ${
              type === "adjustment" ? "bg-amber-500/15 border-amber-500/50 text-amber-400" : "bg-stone-800 border-stone-700 text-stone-400"
            }`}
          >
            <MinusCircle size={18} /> Ajuste (contagem)
          </button>
        </div>

        <div className="space-y-3 mb-5">
          <Field label={type === "purchase" ? "Quantidade a entrar" : "Diferença (positiva ou negativa)"}>
            <input
              type="text"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder={type === "purchase" ? "Ex.: 12" : "Ex.: -2 (perda) ou +3 (sobra)"}
              className={inputClass}
            />
          </Field>
          <Field label="Observação (opcional)">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex.: reposição do fornecedor, quebra no serviço..."
              className={inputClass}
            />
          </Field>
          <div className="flex items-center gap-2 text-stone-500 text-xs bg-stone-800/40 border border-stone-800 rounded-xl px-3 py-2.5">
            <ArrowRightLeft size={14} className="shrink-0" />
            Saldo atual: <b className="text-stone-200">{product.quantity}</b> · saldo após o movimento fica registrado no histórico.
          </div>
        </div>
      </div>
    </Modal>
  );
}
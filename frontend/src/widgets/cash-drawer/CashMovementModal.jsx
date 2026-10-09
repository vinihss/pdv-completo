import React, { useState, useEffect } from "react";
import { Field, inputClass, Modal } from "@/shared/components";
import { formatBRL } from "@/shared/lib";
import { listUsers } from "@/entities/user";
import { useAuth } from "@/app/providers/auth";

const META = {
  sangria: { title: "Sangria", desc: "Retirada de dinheiro do caixa.", button: "Registrar sangria" },
  suprimento: { title: "Suprimento", desc: "Reforço de dinheiro no caixa.", button: "Registrar suprimento" },
};

const CATEGORIAS = [
  { value: "sangria_operacional", label: "Sangria operacional" },
  { value: "suprimento_troco", label: "Suprimento para troco" },
  { value: "pagamento_fornecedor", label: "Pagamento a fornecedor" },
  { value: "ajuste_inventario", label: "Ajuste de inventário" },
  { value: "outros", label: "Outros" },
];

export default function CashMovementModal({ type, expected, onClose, onConfirm }) {
  const meta = META[type];
  const { storeSettings } = useAuth();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("");
  const [approvedByUserId, setApprovedByUserId] = useState("");
  const [confirmZero, setConfirmZero] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [approvers, setApprovers] = useState([]);

  const value = Number(amount);
  const remaining = Number.isNaN(value) || value <= 0 ? null : Math.round((expected - value) * 100) / 100;
  const zeroes = type === "sangria" && remaining !== null && remaining <= 0;
  const threshold = storeSettings?.cashHighValueThreshold ?? 500;
  const requiresApproval = value > threshold;

  // Busca usuários com role manager ou cashier para aprovação
  useEffect(() => {
    if (!requiresApproval) return;
    listUsers()
      .then((users) => {
        const filtered = users.filter((u) => u.role === "manager" || u.role === "cashier");
        setApprovers(filtered);
      })
      .catch(() => setApprovers([]));
  }, [requiresApproval]);

  const canSubmit = !Number.isNaN(value) && value > 0 && category && (!zeroes || confirmZero) && (!requiresApproval || approvedByUserId);

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const ok = await onConfirm({
        amount: Math.round(value * 100) / 100,
        note: note.trim() || undefined,
        category,
        approvedByUserId: requiresApproval ? approvedByUserId : undefined,
      });
      if (ok) onClose();
    } catch (e) {
      const errorCode = e.code || e.message;
      if (errorCode === "approval_required") {
        setError("Este valor exige aprovação. Selecione um gerente aprovador.");
      } else if (errorCode === "invalid_movement_category") {
        setError("Categoria inválida. Selecione uma das opções.");
      } else {
        setError(e.message || "Erro ao registrar movimento.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={meta.title}
      subtitle={meta.desc}
      onClose={onClose}
      footer={
        <button onClick={handleSubmit} disabled={saving || !canSubmit} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl">
          {saving ? "Registrando…" : zeroes && !confirmZero ? "Confirme acima para continuar" : meta.button}
        </button>
      }
    >
      <div className="p-5 space-y-3">
        <Field label="Valor (R$)">
          <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} autoFocus />
        </Field>

        <Field label="Categoria" required>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={inputClass}
          >
            <option value="">Selecione uma categoria</option>
            {CATEGORIAS.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
        </Field>

        {requiresApproval && (
          <Field label="Aprovado por" required>
            <select
              value={approvedByUserId}
              onChange={(e) => setApprovedByUserId(e.target.value)}
              className={inputClass}
            >
              <option value="">Selecione um aprovador</option>
              {approvers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.role === "manager" ? "Gerente" : "Caixa"})
                </option>
              ))}
            </select>
            <p className="text-xs text-stone-500 mt-1">
              Movimento acima de {formatBRL(threshold)} exige aprovação.
            </p>
          </Field>
        )}

        {zeroes && (
          <label className="flex items-start gap-2 mt-2 text-xs bg-amber-950/50 border border-amber-800 rounded-xl px-3 py-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmZero}
              onChange={(e) => setConfirmZero(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <b className="text-amber-400">Zera o caixa.</b>
              <span className="text-stone-300"> O disponível fica R$ 0,00{remaining < 0 ? ` ( −${formatBRL(Math.abs(remaining))})` : ""} — marque para confirmar.</span>
            </span>
          </label>
        )}

        <Field label="Observação (opcional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motivo" className={inputClass} />
        </Field>

        {error && (
          <div className="bg-red-950/50 border border-red-800 rounded-xl px-3 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
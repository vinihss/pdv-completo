import React, { useState, useMemo } from "react";
import { Field, inputClass, Modal } from "@/shared/components";
import { formatBRL } from "@/shared/lib";

const DENOMINATIONS = [
  { value: 200, label: "R$ 200,00" },
  { value: 100, label: "R$ 100,00" },
  { value: 50, label: "R$ 50,00" },
  { value: 20, label: "R$ 20,00" },
  { value: 10, label: "R$ 10,00" },
  { value: 5, label: "R$ 5,00" },
  { value: 2, label: "R$ 2,00" },
  { value: 1, label: "R$ 1,00" },
  { value: 0.5, label: "R$ 0,50" },
  { value: 0.25, label: "R$ 0,25" },
  { value: 0.1, label: "R$ 0,10" },
  { value: 0.05, label: "R$ 0,05" },
  { value: 0.01, label: "R$ 0,01" },
];

const ERROR_MESSAGES = {
  closing_justification_required: "A diferença excede a tolerância. Informe uma justificativa.",
  closing_approval_required: "A diferença excede o limite. Informe o PIN do gerente aprovador.",
  closing_denominations_mismatch: "A soma das cédulas não confere com o total informado.",
};

export default function CloseCashDrawerModal({ expected, onClose, onConfirm }) {
  const [mode, setMode] = useState("denominations"); // "denominations" | "manual"
  const [quantities, setQuantities] = useState({});
  const [manualCounted, setManualCounted] = useState("");
  const [justification, setJustification] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Calcula o total contado pelas denominações
  const denominationsTotal = useMemo(() => {
    return DENOMINATIONS.reduce((sum, denom) => {
      const qty = Number(quantities[denom.value] || 0);
      return sum + qty * denom.value;
    }, 0);
  }, [quantities]);

  // Valor contado conforme o modo
  const countedValue = mode === "denominations"
    ? Math.round(denominationsTotal * 100) / 100
    : Number(manualCounted || 0);

  const hasInput = mode === "denominations"
    ? Object.values(quantities).some((q) => Number(q) > 0)
    : manualCounted !== "";

  const difference = hasInput
    ? Math.round((countedValue - expected) * 100) / 100
    : null;

  function handleQuantityChange(denomValue, value) {
    const qty = value === "" ? "" : Math.max(0, Math.floor(Number(value)));
    setQuantities((prev) => ({ ...prev, [denomValue]: qty }));
    setError(null);
  }

  async function handleSubmit() {
    if (!hasInput) return;
    if (Number.isNaN(countedValue) || countedValue < 0) return;

    setSaving(true);
    setError(null);

    const payload = {
      countedValue,
      note: justification.trim() || undefined,
      justification: justification.trim() || undefined,
    };

    if (mode === "denominations") {
      // Envia apenas denominações com quantidade > 0
      const denominations = DENOMINATIONS
        .filter((d) => Number(quantities[d.value] || 0) > 0)
        .map((d) => ({
          denomination: d.value,
          quantity: Number(quantities[d.value]),
          subtotal: Math.round(Number(quantities[d.value]) * d.value * 100) / 100,
        }));
      payload.denominations = denominations;
    }

    if (managerPin.trim()) {
      // TODO: Validar PIN do gerente via API (POST /auth/login com role=manager)
      // antes de enviar o fechamento. Por enquanto, envia o PIN e o backend decide.
      payload.approvedByPin = managerPin.trim();
    }

    try {
      const ok = await onConfirm(payload);
      if (ok) {
        onClose();
      }
    } catch (e) {
      const errorCode = e.code || e.message;
      const errorMsg = ERROR_MESSAGES[errorCode] || e.message || "Erro ao fechar caixa.";
      setError(errorMsg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Fechar caixa"
      onClose={onClose}
      footer={
        <button
          onClick={handleSubmit}
          disabled={saving || !hasInput}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl"
        >
          {saving ? "Fechando…" : "Fechar caixa"}
        </button>
      }
    >
      <div className="p-5 space-y-4">
        {/* Toggle de modo */}
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMode("denominations")}
            className={`flex-1 py-2 rounded-xl font-medium transition-colors ${
              mode === "denominations"
                ? "bg-amber-500 text-stone-950"
                : "bg-stone-800 text-stone-400 hover:bg-stone-700"
            }`}
          >
            Contar por cédula
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={`flex-1 py-2 rounded-xl font-medium transition-colors ${
              mode === "manual"
                ? "bg-amber-500 text-stone-950"
                : "bg-stone-800 text-stone-400 hover:bg-stone-700"
            }`}
          >
            Informar total manualmente
          </button>
        </div>

        {/* Modo denominações */}
        {mode === "denominations" && (
          <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 space-y-2">
            <div className="text-stone-400 text-xs font-bold uppercase tracking-wide mb-2">
              Contagem por denominação
            </div>
            {DENOMINATIONS.map((denom) => {
              const qty = Number(quantities[denom.value] || 0);
              const subtotal = Math.round(qty * denom.value * 100) / 100;
              return (
                <div key={denom.value} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 text-stone-300 font-medium">{denom.label}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={quantities[denom.value] || ""}
                    onChange={(e) => handleQuantityChange(denom.value, e.target.value)}
                    placeholder="0"
                    className={`${inputClass} w-20 text-right`}
                  />
                  <span className="w-24 text-right text-stone-400 text-xs">
                    {qty > 0 ? formatBRL(subtotal) : "—"}
                  </span>
                </div>
              );
            })}
            <div className="border-t border-stone-700 pt-2 mt-3 flex items-center justify-between">
              <span className="text-stone-400 text-sm font-semibold">Total contado</span>
              <span className="text-emerald-400 font-bold text-base">
                {formatBRL(denominationsTotal)}
              </span>
            </div>
          </div>
        )}

        {/* Modo manual */}
        {mode === "manual" && (
          <Field label="Contado (R$)">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={manualCounted}
              onChange={(e) => setManualCounted(e.target.value)}
              className={inputClass}
              autoFocus
              placeholder="0,00"
            />
          </Field>
        )}

        {/* Quadro esperado / contado / diferença — só aparece depois de preencher */}
        {hasInput && difference !== null && (
          <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-stone-400">Esperado</span>
              <span className="font-semibold text-stone-200">{formatBRL(expected)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-stone-400">Contado</span>
              <span className="font-semibold text-stone-200">{formatBRL(countedValue)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-stone-700 pt-2">
              <span className="text-stone-400">Diferença</span>
              <span
                className={`font-bold ${
                  difference > 0
                    ? "text-emerald-400"
                    : difference < 0
                    ? "text-red-400"
                    : "text-stone-400"
                }`}
              >
                {difference > 0 ? "+" : ""}
                {formatBRL(difference)}
              </span>
            </div>
          </div>
        )}

        {/* Justificativa */}
        <Field label="Justificativa (obrigatória se houver diferença)">
          <textarea
            value={justification}
            onChange={(e) => {
              setJustification(e.target.value);
              setError(null);
            }}
            placeholder={
              difference !== null && difference !== 0
                ? "Explique o motivo da variação"
                : "Opcional — preencha se houver diferença"
            }
            className={`${inputClass} resize-none`}
            rows={2}
          />
        </Field>

        {/* PIN do gerente aprovador — aparece condicionalmente após erro */}
        {error === ERROR_MESSAGES.closing_approval_required && (
          <Field label="PIN do gerente aprovador" required>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={managerPin}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                setManagerPin(digits);
                setError(null);
              }}
              placeholder="Digite o PIN do gerente"
              className={inputClass}
              autoFocus
            />
          </Field>
        )}

        {/* Erro */}
        {error && (
          <div className="bg-red-950/50 border border-red-800 rounded-xl px-3 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
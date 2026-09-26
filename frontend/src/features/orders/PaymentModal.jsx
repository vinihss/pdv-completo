import React, { useState } from "react";
import {
  Banknote, CreditCard, QrCode, MoreHorizontal, AlertTriangle,
  Plus, Trash2, Minus, Users, Check,
} from "lucide-react";
import { setPayments, confirmPayment } from "@/entities/order";
import { orderTotal, round2 } from "@/entities/order";
import { formatBRL } from "@/shared/lib";
import { Modal } from "@/shared/components";
import PixQrScreen from "./PixQrScreen.jsx";

const PAYMENT_META = {
  cash: { label: "Dinheiro", icon: Banknote },
  card: { label: "Cartão", icon: CreditCard },
  pix: { label: "Pix", icon: QrCode },
  other: { label: "Outro", icon: MoreHorizontal },
};

let uidSeq = 0;
function newLineId() {
  return `pl-${Date.now()}-${uidSeq++}`;
}

export default function PaymentModal({ order, enabledMethods, storeSettings, onClose, onConfirmed, showToast }) {
  const [lines, setLines] = useState(() =>
    (order.payments ?? []).map((p) => ({
      id: p.id,
      method: p.method,
      amount: String(p.amount ?? ""),
      received: p.received != null ? String(p.received) : String(p.amount ?? ""),
      confirmed: p.confirmed,
    }))
  );
  const [submitting, setSubmitting] = useState(false);
  const [splitN, setSplitN] = useState(2);
  const [splitMethod, setSplitMethod] = useState(
    enabledMethods.includes("pix") ? "pix" : enabledMethods[0]
  );
  const [pixQueue, setPixQueue] = useState(null); // [{id, amount}] pendentes de confirmação

  const pixKey = (storeSettings?.pixKey ?? "").trim();
  const merchantName = (storeSettings?.merchantName ?? "").trim();
  const merchantCity = (storeSettings?.merchantCity ?? "").trim();
  const pixAvailable = Boolean(pixKey && merchantName && merchantCity);

  const total = orderTotal(order);
  const sumAmount = round2(lines.reduce((acc, l) => acc + (parseFloat(l.amount) || 0), 0));
  const remaining = round2(total - sumAmount);
  const balanced = Math.abs(remaining) < 0.005;

  const cashOk = lines.every((l) => {
    if (l.method !== "cash") return true;
    const amount = parseFloat(l.amount) || 0;
    const received = parseFloat(l.received) || 0;
    return received >= amount - 0.005;
  });

  const canSave = lines.length > 0 && balanced && cashOk && !submitting;

  function updateLine(id, patch) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addMethod(m) {
    setLines((prev) => [
      ...prev,
      {
        id: newLineId(),
        method: m,
        amount: Math.max(0, remaining).toFixed(2),
        received: Math.max(0, remaining).toFixed(2),
        confirmed: false,
      },
    ]);
  }

  function removeLine(id) {
    setLines((prev) => prev.filter((l) => l.id !== id));
  }

  function applySplit() {
    const n = Math.max(1, Math.min(20, splitN));
    const perHead = Math.floor((total * 100) / n) / 100;
    const next = [];
    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const amount = isLast ? round2(total - perHead * (n - 1)) : perHead;
      next.push({
        id: newLineId(),
        method: splitMethod,
        amount: amount.toFixed(2),
        received: amount.toFixed(2),
        confirmed: false,
      });
    }
    setLines(next);
  }

  function remainingLabel() {
    if (lines.length === 0) return "Adicione uma ou mais formas de pagamento.";
    if (balanced) return "Valores conferem com o total da comanda.";
    if (remaining > 0) return `Falta R$ ${formatBRL(remaining)} para cobrir o total.`;
    return `Os valores excedem o total em R$ ${formatBRL(-remaining)}.`;
  }

  async function handleSave() {
    setSubmitting(true);
    try {
      const payload = lines.map((l) => {
        const amount = round2(parseFloat(l.amount) || 0);
        const received = round2(parseFloat(l.received) || 0);
        return {
          method: l.method,
          amount,
          ...(l.method === "cash" ? { received } : {}),
          confirmed: l.method !== "pix", // pix só confirma depois de ver o QR
        };
      });
      const saved = await setPayments(order.id, payload);
      const pendingPix = (saved.payments ?? []).filter((p) => p.method === "pix" && !p.confirmed);
      if (pendingPix.length > 0) {
        setPixQueue(pendingPix.map((p) => ({ id: p.id, amount: p.amount })));
      } else {
        await onConfirmed();
      }
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePixConfirm() {
    setSubmitting(true);
    try {
      await confirmPayment(order.id, pixQueue[0].id);
      if (pixQueue.length > 1) {
        setPixQueue(pixQueue.slice(1));
      } else {
        await onConfirmed();
      }
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  if (pixQueue) {
    const storeSettingsForPix = { pixKey, merchantName, merchantCity };
    return (
      <Modal
        title={`Pix${pixQueue.length > 1 ? ` (${pixQueue.length} restantes)` : ""}`}
        onClose={() => setPixQueue(null)}
      >
        <div className="p-5">
          <PixQrScreen
            order={order}
            amount={pixQueue[0].amount}
            storeSettings={storeSettingsForPix}
            onBack={() => setPixQueue(null)}
            onConfirm={handlePixConfirm}
            submitting={submitting}
          />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Pagamento"
      subtitle={formatBRL(total)}
      onClose={onClose}
      footer={
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-stone-950 font-semibold py-3.5 rounded-xl"
        >
          {submitting ? "Registrando…" : lines.some((l) => l.method === "pix") ? "Registrar e gerar Pix" : "Registrar pagamento"}
        </button>
      }
    >
      <div className="p-5">
        <div
          className={`mb-4 text-xs rounded-xl px-3 py-2.5 border ${
            balanced
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-amber-500/10 border-amber-500/30 text-amber-400"
          }`}
        >
          {remainingLabel()}
        </div>

        {lines.length > 0 && (
          <div className="space-y-2 mb-4">
            {lines.map((l) => {
              const Icon = PAYMENT_META[l.method].icon;
              const amount = parseFloat(l.amount) || 0;
              const received = parseFloat(l.received) || 0;
              const change = round2(received - amount);
              const cashShort = l.method === "cash" && change < -0.005;
              return (
                <div key={l.id} className="bg-stone-800/60 border border-stone-700 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Icon size={16} className="text-amber-400" />
                      {PAYMENT_META[l.method].label}
                      {l.confirmed && <Check size={14} className="text-emerald-400" />}
                    </span>
                    <button onClick={() => removeLine(l.id)} className="text-stone-600 hover:text-red-400 p-1">
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-stone-500 text-[11px]">Valor (R$)</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={l.amount}
                        onChange={(e) => updateLine(l.id, { amount: e.target.value })}
                        className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-sm"
                      />
                    </label>
                    {l.method === "cash" && (
                      <label className="block">
                        <span className={`text-[11px] ${cashShort ? "text-red-400" : "text-stone-500"}`}>
                          {cashShort ? "Faltam R$ " + formatBRL(-change) : "Recebido (R$)"}
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={l.received}
                          onChange={(e) => updateLine(l.id, { received: e.target.value })}
                          className={`w-full bg-stone-900 border rounded-lg px-3 py-2 text-sm ${
                            cashShort ? "border-red-500/50 text-red-300" : "border-stone-700"
                          }`}
                        />
                      </label>
                    )}
                  </div>
                  {l.method === "cash" && !cashShort && change > 0.004 && (
                    <div className="mt-2 text-xs text-emerald-400">Troco: {formatBRL(change)}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mb-4">
          <div className="text-stone-500 text-xs mb-2">Adicionar forma de pagamento</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {enabledMethods.map((m) => {
              const Icon = PAYMENT_META[m].icon;
              const disabled = m === "pix" && !pixAvailable;
              return (
                <button
                  key={m}
                  onClick={() => addMethod(m)}
                  disabled={disabled}
                  className={`flex flex-col items-center gap-1.5 bg-stone-800 border border-stone-700 rounded-xl py-3 ${
                    disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-stone-750"
                  }`}
                >
                  <Icon size={18} className="text-amber-400" />
                  <span className="text-xs font-semibold">{PAYMENT_META[m].label}</span>
                </button>
              );
            })}
          </div>
          {enabledMethods.includes("pix") && !pixAvailable && (
            <p className="mt-2 text-xs text-stone-500 flex items-center gap-1.5">
              <AlertTriangle size={13} className="shrink-0 text-amber-400" />
              Pix indisponível — configure a chave, o nome e a cidade nas Configurações do gerente.
            </p>
          )}
        </div>

        <div className="bg-stone-800/60 border border-stone-700 rounded-xl p-3 mb-5">
          <div className="flex items-center gap-1.5 text-stone-300 text-xs font-semibold mb-2">
            <Users size={14} className="text-amber-400" /> Dividir igualmente entre
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSplitN((n) => Math.max(1, n - 1))}
              className="bg-stone-900 border border-stone-700 rounded-lg p-2 text-stone-300"
            >
              <Minus size={14} />
            </button>
            <span className="w-10 text-center font-display font-bold">{splitN}</span>
            <button
              onClick={() => setSplitN((n) => Math.min(20, n + 1))}
              className="bg-stone-900 border border-stone-700 rounded-lg p-2 text-stone-300"
            >
              <Plus size={14} />
            </button>
            <div className="flex gap-1.5 ml-2 flex-1">
              {enabledMethods.map((m) => (
                <button
                  key={m}
                  onClick={() => setSplitMethod(m)}
                  disabled={m === "pix" && !pixAvailable}
                  className={`flex-1 text-xs font-semibold py-1.5 rounded-lg border ${
                    splitMethod === m
                      ? "bg-amber-500 text-stone-950 border-amber-500"
                      : "bg-stone-900 text-stone-400 border-stone-700"
                  } ${m === "pix" && !pixAvailable ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  {PAYMENT_META[m].label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={applySplit}
            disabled={total <= 0}
            className="w-full mt-2 bg-stone-700 hover:bg-stone-600 text-stone-100 text-xs font-semibold py-2 rounded-lg"
          >
            Aplicar divisão
          </button>
        </div>

        {!balanced && (
          <p className="text-xs text-stone-500 text-center">
            Ajuste os valores até que a soma bata com o total ({formatBRL(total)}).
          </p>
        )}
      </div>
    </Modal>
  );
}
import React, { useState } from "react";
import { Banknote, CreditCard, QrCode, MoreHorizontal, AlertTriangle, X } from "lucide-react";
import { registerPayment } from "@/shared/api/orders";
import { orderTotal, money } from "./order.utils.js";
import PixQrScreen from "./PixQrScreen.jsx";

const PAYMENT_META = {
  cash: { label: "Dinheiro", icon: Banknote },
  card: { label: "Cartão", icon: CreditCard },
  pix: { label: "Pix", icon: QrCode },
  other: { label: "Outro", icon: MoreHorizontal },
};

export default function PaymentModal({ order, enabledMethods, storeSettings, onClose, onConfirmed, showToast }) {
  const [method, setMethod] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const pixKey = (storeSettings?.pixKey ?? "").trim();
  const merchantName = (storeSettings?.merchantName ?? "").trim();
  const merchantCity = (storeSettings?.merchantCity ?? "").trim();
  const pixAvailable = Boolean(pixKey && merchantName && merchantCity);

  async function handleConfirm() {
    if (!method) return;
    setSubmitting(true);
    try {
      await registerPayment(order.id, method, true);
      await onConfirmed();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSelect(m) {
    if (m !== "pix") {
      setMethod(m);
      return;
    }
    try {
      await registerPayment(order.id, "pix", false);
      setMethod("pix");
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-display text-lg font-bold">Forma de pagamento</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>

        {!method && (
          <div>
            <div className="grid grid-cols-2 gap-3">
              {enabledMethods.map((m) => {
                const meta = PAYMENT_META[m];
                const Icon = meta.icon;
                const disabled = m === "pix" && !pixAvailable;
                return (
                  <button
                    key={m}
                    onClick={() => handleSelect(m)}
                    disabled={disabled}
                    className={`flex flex-col items-center gap-2 bg-stone-800 border border-stone-700 rounded-2xl py-5 ${disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-stone-750"}`}
                  >
                    <Icon size={22} className="text-amber-400" />
                    <span className="text-sm font-semibold">{meta.label}</span>
                  </button>
                );
              })}
            </div>
            {enabledMethods.includes("pix") && !pixAvailable && (
              <p className="mt-3 text-xs text-stone-500 flex items-center gap-1.5">
                <AlertTriangle size={13} className="shrink-0 text-amber-400" />
                Pix indisponível — configure a chave, o nome e a cidade nas Configurações do gerente.
              </p>
            )}
          </div>
        )}

        {method === "pix" && (
          <PixQrScreen
            order={order}
            storeSettings={{ pixKey, merchantName, merchantCity }}
            onBack={() => setMethod(null)}
            onConfirm={handleConfirm}
            submitting={submitting}
          />
        )}

        {method && method !== "pix" && !confirming && (
          <div>
            <div className="text-center py-6">
              <div className="text-stone-400 text-sm mb-1">Total a receber</div>
              <div className="font-display text-3xl font-bold text-emerald-400">{money(orderTotal(order))}</div>
              <div className="text-stone-500 text-sm mt-2">via {PAYMENT_META[method].label}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setMethod(null)} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-3 rounded-xl">
                Voltar
              </button>
              <button
                onClick={() => setConfirming(true)}
                className="flex-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-3 rounded-xl"
              >
                Continuar
              </button>
            </div>
          </div>
        )}

        {method && method !== "pix" && confirming && (
          <div>
            <div className="flex items-center gap-2 text-amber-400 mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5 text-xs">
              <AlertTriangle size={14} className="shrink-0" />
              Confirme que o pagamento em {PAYMENT_META[method].label.toLowerCase()} foi recebido. Essa ação fecha o registro de pagamento.
            </div>
            <div className="flex gap-2">
              <button onClick={() => setConfirming(false)} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-3 rounded-xl">
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting}
                className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl"
              >
                {submitting ? "Confirmando…" : "Confirmar recebimento"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
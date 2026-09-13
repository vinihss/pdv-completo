import React, { useState } from "react";
import { MapPin, Check, AlertTriangle, X, Package } from "lucide-react";
import { api } from "../lib/api.js";
import { useCourierDeliveries } from "../lib/useCourierDeliveries.js";
import { useToast, Toast } from "../components/Toast.jsx";

const STATUS_LABEL = { awaiting_courier: "Aguardando", out_for_delivery: "A caminho" };

/**
 * Rota separada e minimalista, não uma view restrita do painel do manager
 * (decisão registrada em 04-delivery-self-service-integration.md
 * "Superfícies de UI") — sem sidebar, sem navegação, só a lista de tarefas
 * do entregador logado.
 */
export default function CourierApp() {
  const { deliveries, loading, reload } = useCourierDeliveries();
  const { toast, showToast } = useToast();
  const [busyId, setBusyId] = useState(null);
  const [failingId, setFailingId] = useState(null);
  const [failReason, setFailReason] = useState("");

  async function dispatch(id) {
    setBusyId(id);
    try {
      await api.dispatchDelivery(id);
      showToast("Saída registrada", "success");
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function deliver(id) {
    setBusyId(id);
    try {
      await api.deliverDelivery(id);
      showToast("Entrega confirmada 🎉", "success");
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmFail(id) {
    if (!failReason.trim()) return;
    setBusyId(id);
    try {
      await api.failDelivery(id, failReason.trim());
      showToast("Falha registrada", "info");
      setFailingId(null);
      setFailReason("");
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusyId(null);
    }
  }

  const pending = deliveries.filter((d) => d.status === "awaiting_courier").length;

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50">
      <Toast toast={toast} />
      <div className="max-w-md mx-auto min-h-screen flex flex-col">
        <div className="px-5 py-4 border-b border-stone-800">
          <h1 className="text-lg font-bold">Minhas entregas</h1>
          <p className="text-xs text-stone-500 mt-0.5">
            {deliveries.length === 0 ? "Nenhuma pendente" : `${deliveries.length} ${deliveries.length === 1 ? "pendente" : "pendentes"}`}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {loading && deliveries.length === 0 && <p className="text-stone-600 text-sm text-center py-10">Carregando…</p>}

          {!loading && deliveries.length === 0 && (
            <div className="text-center py-16">
              <Package size={32} className="mx-auto text-stone-700 mb-3" />
              <p className="text-sm text-stone-500">Nenhuma entrega pendente no momento.</p>
            </div>
          )}

          {deliveries.map((d) => (
            <div key={d.id} className="bg-stone-900 border border-stone-800 rounded-2xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-stone-500">Pedido #{d.orderId.slice(0, 8)}</p>
                  <div className="flex items-start gap-1.5 mt-1">
                    <MapPin size={14} className="mt-0.5 shrink-0 text-amber-500" />
                    <p className="text-sm font-semibold leading-snug">{d.address}</p>
                  </div>
                </div>
                <span className="shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-400 whitespace-nowrap">
                  {STATUS_LABEL[d.status]}
                </span>
              </div>

              {failingId === d.id ? (
                <div className="mt-3">
                  <input
                    autoFocus
                    value={failReason}
                    onChange={(e) => setFailReason(e.target.value)}
                    placeholder="Motivo (ex: cliente ausente)"
                    className="w-full bg-stone-800 border border-stone-700 rounded-lg px-3 h-10 text-sm outline-none focus:border-red-500"
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => confirmFail(d.id)}
                      disabled={!failReason.trim() || busyId === d.id}
                      className="flex-1 bg-red-600 text-white h-9 rounded-lg text-sm font-semibold disabled:opacity-40"
                    >
                      Confirmar falha
                    </button>
                    <button
                      onClick={() => { setFailingId(null); setFailReason(""); }}
                      className="w-9 h-9 rounded-lg border border-stone-700 flex items-center justify-center shrink-0"
                      aria-label="Cancelar"
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              ) : d.status === "awaiting_courier" ? (
                <button
                  onClick={() => dispatch(d.id)}
                  disabled={busyId === d.id}
                  className="w-full mt-3 bg-amber-500 text-stone-950 h-10 rounded-lg text-sm font-semibold disabled:opacity-50"
                >
                  Saí para entrega
                </button>
              ) : (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => deliver(d.id)}
                    disabled={busyId === d.id}
                    className="flex-1 bg-amber-500 text-stone-950 h-10 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <Check size={15} />
                    Entreguei
                  </button>
                  <button
                    onClick={() => setFailingId(d.id)}
                    disabled={busyId === d.id}
                    className="w-10 h-10 rounded-lg border border-red-900 text-red-400 flex items-center justify-center shrink-0"
                    aria-label="Marcar falha na entrega"
                  >
                    <AlertTriangle size={16} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-stone-800">
          <p className="text-center text-xs text-stone-500">
            {pending > 0 ? `${pending} aguardando saída` : "Tudo em dia por aqui"}
          </p>
        </div>
      </div>
    </div>
  );
}

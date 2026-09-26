import React, { useState } from "react";
import { RefreshCcw, AlertTriangle, X } from "lucide-react";
import { assignCourier } from "@/entities/delivery";
import { cancelOrder } from "@/entities/order";
import { useDeliveries } from "./useDeliveries.js";
import { inputClass } from "@/shared/components";

const DELIVERY_STATUS_LABEL = { awaiting_courier: "Aguardando", out_for_delivery: "A caminho", delivered: "Entregue", failed: "Falhou" };
const DELIVERY_STATUS_CLASS = {
  awaiting_courier: "bg-amber-500/15 text-amber-400",
  out_for_delivery: "bg-sky-500/15 text-sky-400",
  delivered: "bg-emerald-500 text-emerald-950",
  failed: "bg-red-500/15 text-red-400",
};

export function DeliveryStatusBadge({ status }) {
  return (
    <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${DELIVERY_STATUS_CLASS[status] ?? DELIVERY_STATUS_CLASS.awaiting_courier}`}>
      {DELIVERY_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function DeliveriesTab({ showToast }) {
  const { deliveries, couriers, loading, reload } = useDeliveries();
  const [assigning, setAssigning] = useState(null); // deliveryId em progresso
  const [openReasonFor, setOpenReasonFor] = useState(null); // deliveryId com o campo de motivo aberto
  const [submitting, setSubmitting] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  // O backend não devolve o status do pedido nessa lista (só o da entrega,
  // que fica "failed" pra sempre mesmo depois de cancelado) — rastreia
  // localmente pra não deixar cancelar de novo por engano na mesma sessão.
  const [justCancelled, setJustCancelled] = useState(() => new Set());

  async function handleAssign(deliveryId, courierId) {
    if (!courierId) return;
    setAssigning(deliveryId);
    try {
      await assignCourier(deliveryId, courierId);
      showToast("Entregador atribuído.", "success");
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setAssigning(null);
    }
  }

  async function handleCancel(delivery) {
    if (!cancelReason.trim()) return;
    setSubmitting(true);
    try {
      await cancelOrder(delivery.orderId, cancelReason.trim());
      showToast("Pedido cancelado.", "success");
      setJustCancelled((s) => new Set(s).add(delivery.id));
      setOpenReasonFor(null);
      setCancelReason("");
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  const awaitingCount = deliveries.filter((d) => d.status === "awaiting_courier").length;
  const outCount = deliveries.filter((d) => d.status === "out_for_delivery").length;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-4 text-sm text-stone-400">
        <span>{awaitingCount} aguardando</span>
        <span>{outCount} a caminho</span>
        <button onClick={reload} className="ml-auto flex items-center gap-1.5 text-stone-500 hover:text-stone-300">
          <RefreshCcw size={13} /> Atualizar
        </button>
      </div>

      {loading && deliveries.length === 0 && <div className="text-stone-600 text-sm py-8 text-center">Carregando…</div>}
      {!loading && deliveries.length === 0 && <div className="text-stone-600 text-sm py-8 text-center">Nenhuma entrega no momento.</div>}

      <div className="space-y-2.5">
        {deliveries.map((d) => (
          <div key={d.id} className="bg-stone-900 border border-stone-800 rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-stone-500">Pedido #{d.orderId.slice(0, 8)}</p>
                <p className="text-sm font-medium mt-0.5 truncate">{d.address}</p>
              </div>
              <DeliveryStatusBadge status={d.status} />
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              {d.status === "awaiting_courier" && !d.courier ? (
                <select
                  disabled={assigning === d.id}
                  onChange={(e) => handleAssign(d.id, e.target.value)}
                  defaultValue=""
                  className={inputClass + " max-w-[220px]"}
                >
                  <option value="" disabled>Atribuir entregador</option>
                  {couriers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-stone-400">{d.courier?.name ?? "— não atribuído —"}</span>
              )}

              <span className="text-xs text-stone-500 shrink-0">
                {d.status === "awaiting_courier" && d.courier && "Aguardando saída"}
                {d.status === "out_for_delivery" && d.dispatchedAt && `Saiu às ${new Date(d.dispatchedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
                {d.status === "delivered" && d.deliveredAt && new Date(d.deliveredAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>

            {d.status === "failed" && (
              <div className="mt-2 pt-2 border-t border-stone-800">
                <p className="text-xs text-red-400 mb-2">Motivo da falha: {d.notes}</p>
                {justCancelled.has(d.id) ? (
                  <p className="text-xs text-stone-500">Pedido cancelado.</p>
                ) : openReasonFor === d.id ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder="Motivo do cancelamento"
                      className={inputClass + " flex-1"}
                    />
                    <button
                      onClick={() => handleCancel(d)}
                      disabled={!cancelReason.trim() || submitting}
                      className="bg-red-600 text-white px-3 rounded-lg text-xs font-semibold disabled:opacity-40"
                    >
                      Confirmar
                    </button>
                    <button
                      onClick={() => { setOpenReasonFor(null); setCancelReason(""); }}
                      className="px-2 rounded-lg border border-stone-700 text-xs"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setOpenReasonFor(d.id); setCancelReason(d.notes ?? ""); }}
                    className="text-xs font-semibold text-red-400 border border-red-900 rounded-lg px-2.5 py-1.5"
                  >
                    Cancelar pedido
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {couriers.length === 0 && !loading && (
        <div className="flex items-center gap-2 text-amber-400 text-sm bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
          <AlertTriangle size={14} /> Nenhum entregador cadastrado — crie um usuário com papel "courier" em Equipe.
        </div>
      )}
    </div>
  );
}
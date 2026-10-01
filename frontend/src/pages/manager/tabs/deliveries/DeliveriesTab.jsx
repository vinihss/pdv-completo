import React, { useState } from "react";
import { RefreshCcw, AlertTriangle, X, MapPin, ChevronDown } from "lucide-react";
import {
  assignCourier,
  setDeliveryStatus,
  DeliveryStatusBadge,
  allowedTransitions,
  statusNeedsReason,
  isOpenDelivery,
} from "@/entities/delivery";
import { cancelOrder } from "@/entities/order";
import { useDeliveries } from "@/entities/delivery";
import { useOrderFocus } from "@/app/providers/order-focus";
import { formatDateTime } from "@/shared/lib";
import { inputClass } from "@/shared/components";

export default function DeliveriesTab({ showToast }) {
  const { deliveries, couriers, loading, reload } = useDeliveries();
  const { focusOrder } = useOrderFocus();
  const [assigning, setAssigning] = useState(null); // deliveryId em progresso
  const [openReasonFor, setOpenReasonFor] = useState(null); // deliveryId com o campo de motivo aberto
  const [submitting, setSubmitting] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  // Entregues e canceladas saem da lista por padrão: a tela do balcão é fila
  // de trabalho, e uma entrega resolvida enterre a próxima atrás dela. O
  // toggle devolve o histórico sem precisar trocar de tela.
  const [showResolved, setShowResolved] = useState(false);
  // Troca de status em voo (deliveryId) e o pedido de motivo: guarda a
  // ENTREGA e o STATUS de destino juntos, porque o motivo pertence ao par —
  // com dois estados soltos, abrir o motivo da entrega A e depois da B
  // deixaria o campo apontando para a entrega errada.
  const [changingStatus, setChangingStatus] = useState(null);
  const [reasonFor, setReasonFor] = useState(null); // { id, status }
  // O backend não devolve o status do pedido nessa lista (só o da entrega,
  // que fica "failed" pra sempre mesmo depois de cancelado) — rastreia
  // localmente pra não deixar cancelar de novo por engano na mesma sessão.
  const [justCancelled, setJustCancelled] = useState(() => new Set());

  const visible = showResolved ? deliveries : deliveries.filter(isOpenDelivery);

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

  async function handleStatus(deliveryId, status, reason) {
    setChangingStatus(deliveryId);
    try {
      await setDeliveryStatus(deliveryId, status, reason);
      showToast(`Entrega ${status === "delivered" ? "concluída" : "atualizada"}.`, "success");
      setReasonFor(null);
      setCancelReason("");
      await reload();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setChangingStatus(null);
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

  // Contadores sobre a lista EXIBIDA: com o histórico aberto, "3 aguardando"
  // precisa descrever as 3 que estão na tela, não só as pendentes.
  const awaitingCount = visible.filter((d) => d.status === "awaiting_courier").length;
  const outCount = visible.filter((d) => d.status === "out_for_delivery").length;
  const resolvedCount = deliveries.length - visible.length;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-4 text-sm text-stone-400">
        <span>{awaitingCount} aguardando</span>
        <span>{outCount} a caminho</span>
        <button onClick={reload} className="ml-auto flex items-center gap-1.5 text-stone-500 hover:text-stone-300">
          <RefreshCcw size={13} /> Atualizar
        </button>
      </div>

      {/* O toggle só aparece quando há o que revelar — com nada resolvido no
          histórico ele seria um controle morto na tela. */}
      {(resolvedCount > 0 || showResolved) && (
        <label className="flex items-center gap-2 text-xs text-stone-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="accent-amber-500 w-3.5 h-3.5"
          />
          Mostrar entregues e canceladas ({resolvedCount})
        </label>
      )}

      {loading && visible.length === 0 && <div className="text-stone-600 text-sm py-8 text-center">Carregando…</div>}
      {!loading && visible.length === 0 && (
        <div className="text-stone-600 text-sm py-8 text-center">
          {resolvedCount > 0
            ? "Nenhuma entrega pendente — todas as do período já foram concluídas ou canceladas."
            : "Nenhuma entrega no momento."}
        </div>
      )}

      <div className="space-y-2.5">
        {visible.map((d) => (
          <div
            key={d.id}
            role="button"
            tabIndex={0}
            data-testid="delivery-card"
            // O card é um button para leitor de tela, então o nome acessível
            // é a concatenação de tudo que está dentro — endereço, datas e o
            // select de atribuir. Um rótulo curto e útil vale mais que isso.
            aria-label={`Abrir comanda de ${d.customerName ?? "cliente sem nome"}`}
            onClick={() => focusOrder(d.orderId)}
            onKeyDown={(e) => {
              // `e.target !== e.currentTarget` porque o card tem controles
              // dentro (os <select> de atribuir e de status): sem isso, Espaço
              // no select fechava o dropdown e abria a comanda junto.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                focusOrder(d.orderId);
              }
            }}
            className="bg-stone-900 border border-stone-800 rounded-2xl p-4 cursor-pointer transition-colors hover:bg-stone-850 hover:border-stone-700 active:scale-[0.99]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-stone-500">Pedido #{d.orderId.slice(0, 8)}</p>
                <p className="text-sm font-semibold mt-0.5 truncate">{d.customerName ?? "— sem nome —"}</p>
                <div className="flex items-start gap-1.5 mt-1">
                  <MapPin size={12} className="mt-0.5 shrink-0 text-stone-500" />
                  <p className="text-xs text-stone-400 leading-snug">{d.address}</p>
                </div>
                <p className="text-xs text-stone-500 mt-1.5" data-testid="delivery-datetime">
                  {formatDateTime(d.createdAt)}
                  {d.deliveredAt && (
                    <span className="text-emerald-400"> · Entregue {formatDateTime(d.deliveredAt)}</span>
                  )}
                </p>
              </div>
              <DeliveryStatusBadge status={d.status} className="shrink-0" />
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              {d.status === "awaiting_courier" && !d.courier ? (
                <select
                  aria-label={`Atribuir entregador para ${d.customerName ?? "cliente sem nome"}`}
                  disabled={assigning === d.id}
                  onClick={(e) => e.stopPropagation()}
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
                {d.status === "out_for_delivery" &&
                  d.dispatchedAt &&
                  `Saiu às ${new Date(d.dispatchedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
              </span>
            </div>

            {/* Correção de status pelo balcão. Só o gerente chega aqui (a rota
                é `requireRole("manager")`), e o <select> oferece apenas as
                transições válidas a partir do status atual — mandar todos os
                status faria o gerente descobrir a regra por erro do servidor,
                uma tentativa por vez. `delivered`/`cancelled` são terminais e
                não renderizam controle nenhum. */}
            {allowedTransitions(d.status).length > 0 && (
              <div
                className="mt-2.5 pt-2.5 border-t border-stone-800"
                onClick={(e) => e.stopPropagation()}
              >
                {reasonFor?.id === d.id ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder={reasonFor.status === "failed" ? "Motivo da falha" : "Motivo do cancelamento"}
                      className={inputClass + " flex-1"}
                    />
                    <button
                      onClick={() => handleStatus(d.id, reasonFor.status, cancelReason.trim())}
                      disabled={!cancelReason.trim() || changingStatus === d.id}
                      className="bg-amber-500 text-stone-950 px-3 rounded-lg text-xs font-semibold disabled:opacity-40"
                    >
                      Confirmar
                    </button>
                    <button
                      onClick={() => { setReasonFor(null); setCancelReason(""); }}
                      className="px-2 rounded-lg border border-stone-700 text-xs"
                      aria-label="Cancelar edição de status"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-stone-500 shrink-0">Status</label>
                    <div className="relative flex-1">
                      <select
                        disabled={changingStatus === d.id}
                        value=""
                        onChange={(e) => {
                          const next = e.target.value;
                          if (!next) return;
                          // Cancelar e falhar guardam o texto que o cliente
                          // recebe na notificação: sem motivo, não vai.
                          if (statusNeedsReason(next)) {
                            setCancelReason("");
                            setReasonFor({ id: d.id, status: next });
                            return;
                          }
                          handleStatus(d.id, next);
                        }}
                        aria-label={`Alterar status da entrega de ${d.customerName ?? "cliente"}`}
                        className={`${inputClass} appearance-none pr-8 ${
                          changingStatus === d.id ? "opacity-50" : ""
                        }`}
                      >
                        <option value="">Alterar status…</option>
                        {allowedTransitions(d.status).map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <ChevronDown
                        size={13}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 pointer-events-none"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {d.status === "failed" && (
              <div className="mt-2 pt-2 border-t border-stone-800" onClick={(e) => e.stopPropagation()}>
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
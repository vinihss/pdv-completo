import React, { useState } from "react";
import {
  ChevronLeft, Plus, Check, Trash2, AlertTriangle, Clock,
} from "lucide-react";
import { updateItemStatus, deleteItem, closeOrder } from "@/shared/api/orders";
import { useAuth } from "@/app/providers/auth";
import { StatusBadge } from "@/shared/components";
import {
  orderLabel,
  orderTotal,
  pendingItems,
  variationsText,
  money,
} from "./order.utils.js";
import AddItemScreen from "./AddItemScreen.jsx";
import PaymentModal from "./PaymentModal.jsx";

export default function OrderDetailScreen({ order, kitchenEnabled, onBack, onReload, showToast }) {
  const { storeSettings } = useAuth();
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busyItemId, setBusyItemId] = useState(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);

  const pending = pendingItems(order);
  const canClose = pending.length === 0;
  const payments = order.payments ?? [];
  const hasPayments = payments.length > 0;

  async function handleItemTap(item) {
    if (item.status === "delivered" || item.status === "cancelled") return;
    const isDeliverable = kitchenEnabled ? item.status === "ready" : item.status === "ordered";
    if (!isDeliverable) return; // ainda em preparo, cozinha decide
    setBusyItemId(item.id);
    try {
      await updateItemStatus(order.id, item.id, "delivered", item.version);
      await onReload();
    } catch (e) {
      if (e.code === "concurrency_conflict") {
        showToast("Este item foi alterado por outra pessoa. Lista atualizada.", "error");
        await onReload();
      } else {
        showToast(e.message, "error");
      }
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleDeleteConfirmed(item) {
    setConfirmDelete(null);
    try {
      await deleteItem(order.id, item.id);
      await onReload();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleClose() {
    setCloseError(null);
    if (!canClose) return;
    if (!hasPayments) {
      setPaymentOpen(true);
      return;
    }
    setClosing(true);
    try {
      await closeOrder(order.id);
      showToast("Comanda fechada.", "success");
      onBack();
    } catch (e) {
      if (e.code === "pending_items") {
        setCloseError("Ainda há itens pendentes: " + e.details.pendingItems.map((i) => i.name).join(", "));
      } else if (e.code === "payment_not_registered" || e.code === "payment_not_confirmed" || e.code === "invalid_payment_total") {
        setPaymentOpen(true);
      } else {
        showToast(e.message, "error");
      }
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 pb-32">
      <div className="px-5 pt-6 pb-4 sticky top-12 bg-stone-950/95 backdrop-blur z-10 border-b border-stone-900 flex items-center gap-3">
        <button onClick={onBack} className="text-stone-400 hover:text-stone-200">
          <ChevronLeft size={22} />
        </button>
        <div className="flex-1">
          <h1 className="font-display text-lg font-bold leading-tight">{orderLabel(order)}</h1>
          <p className="text-stone-500 text-xs">{order.items.length} {order.items.length === 1 ? "item" : "itens"} · {money(orderTotal(order))}</p>
        </div>
      </div>

      <div className="px-5 pt-4 divide-y divide-stone-900">
        {order.items.length === 0 && (
          <div className="text-stone-600 text-center py-16">Nenhum item lançado ainda.</div>
        )}
        {order.items.map((it) => {
          const isDeliverable = kitchenEnabled ? it.status === "ready" : it.status === "ordered";
          const canDelete = kitchenEnabled ? it.status !== "delivered" : true;
          const variations = variationsText(it.selectedVariations);
          return (
            <div
              key={it.id}
              onClick={() => handleItemTap(it)}
              className={`py-3.5 flex items-center gap-3 ${
                isDeliverable ? "cursor-pointer ring-1 ring-emerald-500/40 -mx-3 px-3 rounded-xl" : ""
              } ${kitchenEnabled && it.status === "delivered" ? "opacity-50" : ""}`}
            >
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">
                  {it.quantity}× {it.name}
                </div>
                {variations && <div className="text-stone-500 text-xs mt-0.5">{variations}</div>}
                {it.notes && <div className="text-stone-600 text-xs italic mt-0.5">{it.notes}</div>}
              </div>
              <div className="text-stone-400 text-sm shrink-0">{money(it.unitPrice * it.quantity)}</div>
              <div className="flex items-center gap-2 shrink-0">
                {kitchenEnabled && <StatusBadge status={it.status} />}
                {canDelete && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(it);
                    }}
                    className="text-stone-600 hover:text-red-400 p-1"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
                {busyItemId === it.id && <Clock size={14} className="text-stone-500 animate-pulse" />}
              </div>
            </div>
          );
        })}
      </div>

      {!kitchenEnabled && order.items.some((i) => i.status === "ordered") && (
        <div className="px-5 pt-4">
          <div className="text-stone-500 text-xs bg-stone-900 border border-stone-800 rounded-xl px-3 py-2.5">
            Sem cozinha cadastrada — toque no item para marcar como entregue.
          </div>
        </div>
      )}

      {closeError && (
        <div className="px-5 pt-4">
          <div className="flex items-start gap-2 text-amber-400 text-xs bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {closeError}
          </div>
        </div>
      )}

      {hasPayments && (
        <div className="px-5 pt-4 space-y-1.5">
          <div className="flex items-center gap-2 text-emerald-400 text-xs bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2.5">
            <Check size={14} />
            <div className="flex-1">
              <div className="font-semibold">Pagamento registrado</div>
            </div>
            <button onClick={() => setPaymentOpen(true)} className="underline underline-offset-2">Ajustar</button>
          </div>
          {payments.map((p) => {
            const label = { cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" }[p.method] ?? p.method;
            return (
              <div key={p.id} className="flex items-center justify-between text-xs bg-stone-900 border border-stone-800 rounded-xl px-3 py-2">
                <span className="text-stone-400">
                  {label}
                  {!p.confirmed && <span className="ml-1.5 text-amber-400">aguardando confirmação</span>}
                </span>
                <div className="text-right">
                  <div className="font-semibold text-stone-200">{money(p.amount)}</div>
                  {p.change > 0 && <div className="text-emerald-400">troco {money(p.change)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 p-4 border-t border-stone-800 bg-stone-900 z-30 space-y-2">
        <button
          onClick={() => setAddItemOpen(true)}
          className="w-full flex items-center justify-center gap-2 bg-stone-800 hover:bg-stone-750 border border-stone-700 text-stone-100 font-semibold py-3 rounded-xl transition-colors"
        >
          <Plus size={18} /> Adicionar item
        </button>
        {!canClose ? (
          <button disabled className="w-full bg-stone-800 text-stone-600 font-semibold py-3.5 rounded-xl cursor-not-allowed">
            Fechar conta ({pending.length} pendente{pending.length > 1 ? "s" : ""})
          </button>
        ) : (
          <button
            onClick={handleClose}
            disabled={closing}
            className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors"
          >
            {closing ? "Fechando…" : hasPayments ? "Fechar conta" : "Registrar pagamento e fechar"}
          </button>
        )}
      </div>

      {addItemOpen && (
        <AddItemScreen
          order={order}
          onClose={() => setAddItemOpen(false)}
          onConfirmed={async () => {
            setAddItemOpen(false);
            await onReload();
          }}
          showToast={showToast}
        />
      )}

      {paymentOpen && (
        <PaymentModal
          order={order}
          storeSettings={storeSettings}
          enabledMethods={storeSettings?.enabledPaymentMethods ?? ["cash", "card", "pix", "other"]}
          onClose={() => setPaymentOpen(false)}
          onConfirmed={async () => {
            setPaymentOpen(false);
            await onReload();
          }}
          showToast={showToast}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="w-full max-w-xs bg-stone-900 border border-stone-800 rounded-2xl p-5 fade-up">
            <div className="flex items-center gap-2 text-amber-400 mb-3">
              <AlertTriangle size={18} />
              <span className="font-semibold text-sm">Remover item?</span>
            </div>
            <p className="text-stone-400 text-sm mb-5">
              {confirmDelete.quantity}× {confirmDelete.name} será removido da comanda. Essa ação não pode ser desfeita.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(null)} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-2.5 rounded-xl">
                Cancelar
              </button>
              <button
                onClick={() => handleDeleteConfirmed(confirmDelete)}
                className="flex-1 bg-red-500 hover:bg-red-400 text-stone-950 font-semibold py-2.5 rounded-xl"
              >
                Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
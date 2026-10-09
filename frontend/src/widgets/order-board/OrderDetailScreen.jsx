import React, { useState } from "react";
import {
  Plus, Check, Trash2, Clock, AlertTriangle, Printer, MapPin, MessageSquare,
} from "lucide-react";
import { ConfirmModal, ScreenHeader } from "@/shared/components";
import { updateItemStatus, deleteItem, closeOrder } from "@/entities/order";
import { printOrder } from "@/entities/printer";
import { useAuth } from "@/app/providers/auth";
import { formatBRL } from "@/shared/lib";
import { StatusBadge } from "@/entities/order";
import {
  orderLabel,
  orderTotal,
  orderItemCounts,
  pendingItems,
  variationsText,
} from "@/entities/order";
import { AddItemScreen } from "@/features/orders";
import { PaymentModal, PrintLayoutModal } from "@/features/orders";

export default function OrderDetailScreen({ order, kitchenEnabled, onBack, onReload, onItemsConfirmed, showToast }) {
  const { storeSettings } = useAuth();
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [closeAfterPayment, setCloseAfterPayment] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busyItemId, setBusyItemId] = useState(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const printerEnabled = storeSettings?.printerEnabled ?? false;

  async function handlePrint(destination) {
    setPrinting(true);
    try {
      await printOrder(order, destination);
      showToast(`Pedido enviado para impressão (${destination === "kitchen" ? "cozinha" : "entrega"}).`, "success");
      setPrintOpen(false);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setPrinting(false);
    }
  }

  const pending = pendingItems(order);
  const canClose = pending.length === 0;
  const payments = order.payments ?? [];
  const hasPayments = payments.length > 0;
  const hasUnconfirmedPayment = payments.some((p) => !p.confirmed);
  const counts = orderItemCounts(order);

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

  // Fechamento efetivo (uma etapa). Extraído para ser reaproveitado tanto pelo
  // caminho direto ("Fechar conta") quanto pelo fluxo "registrar/confirmar
  // pagamento e fechar" depois do `PaymentModal`.
  async function doClose() {
    setCloseError(null);
    setClosing(true);
    try {
      await closeOrder(order.id);
      showToast("Comanda fechada.", "success");
      onBack();
    } catch (e) {
      if (e.code === "pending_items") {
        setCloseError("Ainda há itens pendentes: " + e.details.pendingItems.map((i) => i.name).join(", "));
      } else if (e.code === "payment_not_registered" || e.code === "payment_not_confirmed" || e.code === "invalid_payment_total") {
        setCloseAfterPayment(true);
        setPaymentOpen(true);
      } else {
        showToast(e.message, "error");
      }
    } finally {
      setClosing(false);
    }
  }

  // "Registrar pagamento e fechar" é uma promessa de conclusão em uma etapa:
  // sem pagamento (ou com Pix aguardando confirmação) abre o modal já marcando
  // que, ao confirmar, deve fechar. Pix não confirmado nunca fecha sozinho.
  async function handleClose() {
    if (closing || !canClose) return;
    setCloseError(null);
    if (!hasPayments || hasUnconfirmedPayment) {
      setCloseAfterPayment(true);
      setPaymentOpen(true);
      return;
    }
    await doClose();
  }

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 pb-32 flex flex-col">
      <div className="sticky top-0 bg-stone-950/95 backdrop-blur z-10">
        <ScreenHeader
          title={orderLabel(order)}
          subtitle={`${order.items.length} ${order.items.length === 1 ? "item" : "itens"} · ${formatBRL(orderTotal(order))}`}
          onBack={onBack}
          right={
            printerEnabled ? (
              <button
                onClick={() => setPrintOpen(true)}
                className="flex items-center gap-1.5 text-stone-400 hover:text-amber-400 transition-colors"
                aria-label="Imprimir pedido"
              >
                <Printer size={18} />
              </button>
            ) : undefined
          }
        />
      </div>

      {order.delivery && (
        <div className="mx-5 mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-400">
            <MapPin size={12} /> Endereço de entrega
          </div>
          <p className="text-sm text-stone-100 leading-snug mt-1">{order.delivery.address}</p>
        </div>
      )}

      {/* Observação do pedido inteiro, escrita pelo cliente no checkout público.
          Fica logo abaixo do endereço e acima dos itens porque é assim que se
          lê: onde entregar, o que observar, e então o que produzir. */}
      {order.notes && (
        <div className="mx-5 mt-3 rounded-xl border border-stone-700 bg-stone-900 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-stone-400">
            <MessageSquare size={12} /> Observação do cliente
          </div>
          <p className="text-sm text-stone-100 leading-snug mt-1 whitespace-pre-line">{order.notes}</p>
        </div>
      )}

      {/* Resumo do trabalho a fazer, no topo da lista: o que já saiu da cozinha
          (ação imediata) e o que ainda está em preparo. Rótulo textual, não só
          cor, para não depender de leitura visual do contorno. */}
      {kitchenEnabled && (counts.ready > 0 || counts.ordered > 0) && (
        <div className="px-5 pt-4">
          <div className="flex items-center gap-2 flex-wrap">
            {counts.ready > 0 && (
              <span className="inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold rounded-lg px-2.5 py-1.5">
                <Check size={13} />
                {counts.ready} {counts.ready === 1 ? "pronto para entregar" : "prontos para entregar"}
              </span>
            )}
            {counts.ordered > 0 && (
              <span className="inline-flex items-center gap-1.5 bg-stone-900 border border-stone-800 text-stone-400 text-xs rounded-lg px-2.5 py-1.5">
                <Clock size={13} />
                {counts.ordered} em preparo
              </span>
            )}
          </div>
        </div>
      )}

      {!kitchenEnabled && counts.ordered > 0 && (
        <div className="px-5 pt-4">
          <div className="text-stone-500 text-xs bg-stone-900 border border-stone-800 rounded-xl px-3 py-2.5">
            <span className="text-stone-300 font-semibold">{counts.ordered} aguardando entrega.</span>{" "}
            Sem cozinha cadastrada — use o botão do item para marcar como entregue.
          </div>
        </div>
      )}

      <div className="px-5 pt-4 divide-y divide-stone-900">
        {order.items.length === 0 && (
          <div className="text-stone-600 text-center py-16">Nenhum item lançado ainda.</div>
        )}
        {order.items.map((it) => {
          const isDeliverable = kitchenEnabled ? it.status === "ready" : it.status === "ordered";
          const canDelete = kitchenEnabled ? it.status !== "delivered" : true;
          const variations = variationsText(it.selectedVariations);
          const isBusy = busyItemId === it.id;
          return (
            <div
              key={it.id}
              className={`py-3.5 flex items-center gap-3 ${
                isDeliverable ? "ring-1 ring-emerald-500/40 -mx-3 px-3 rounded-xl" : ""
              } ${kitchenEnabled && it.status === "delivered" ? "opacity-50" : ""}`}
            >
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">
                  {it.quantity}× {it.name}
                </div>
                {variations && <div className="text-stone-500 text-xs mt-0.5">{variations}</div>}
                {it.notes && <div className="text-stone-600 text-xs italic mt-0.5">{it.notes}</div>}
              </div>
              <div className="text-stone-400 text-sm shrink-0">{formatBRL(it.unitPrice * it.quantity)}</div>
              <div className="flex items-center gap-2 shrink-0">
                {kitchenEnabled && <StatusBadge status={it.status} />}
                {isDeliverable && (
                  <button
                    onClick={() => handleItemTap(it)}
                    disabled={isBusy}
                    className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                  >
                    {isBusy ? (
                      <Clock size={14} className="animate-pulse" />
                    ) : (
                      <Check size={14} strokeWidth={2.5} />
                    )}
                    Marcar como entregue
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={() => setConfirmDelete(it)}
                    aria-label={`Remover ${it.name} da comanda`}
                    className="text-stone-600 hover:text-red-400 p-1"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {closeError && (
        <div className="px-5 pt-4">
          <div className="flex items-start gap-2 text-amber-400 text-xs bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {closeError}
          </div>
        </div>
      )}

      {!canClose && (
        <div className="px-5 pt-4">
          <div className="text-amber-400 text-xs bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
            Fechamento bloqueado — {pending.length} {pending.length === 1 ? "item aguardando entrega" : "itens aguardando entrega"}:{" "}
            {pending.map((i) => `${i.quantity}× ${i.name}`).join(", ")}.
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
            <button
              onClick={() => {
                setCloseAfterPayment(false);
                setPaymentOpen(true);
              }}
              className="underline underline-offset-2"
            >
              Ajustar
            </button>
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
                  <div className="font-semibold text-stone-200">{formatBRL(p.amount)}</div>
                  {p.change > 0 && <div className="text-emerald-400">troco {formatBRL(p.change)}</div>}
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
            {closing
              ? "Fechando…"
              : !hasPayments
                ? "Registrar pagamento e fechar"
                : hasUnconfirmedPayment
                  ? "Confirmar pagamento e fechar"
                  : "Fechar conta"}
          </button>
        )}
      </div>

      {addItemOpen && (
        <AddItemScreen
          order={order}
          onClose={() => setAddItemOpen(false)}
          onConfirmed={async (count) => {
            setAddItemOpen(false);
            if (onItemsConfirmed) {
              await onItemsConfirmed(count);
            } else {
              await onReload();
            }
          }}
          showToast={showToast}
        />
      )}

      {paymentOpen && (
        <PaymentModal
          order={order}
          storeSettings={storeSettings}
          enabledMethods={storeSettings?.enabledPaymentMethods ?? ["cash", "card", "pix", "other"]}
          onClose={() => {
            setPaymentOpen(false);
            setCloseAfterPayment(false);
          }}
          onConfirmed={async () => {
            setPaymentOpen(false);
            await onReload();
            if (closeAfterPayment) {
              setCloseAfterPayment(false);
              await doClose();
            }
          }}
          showToast={showToast}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Remover item?"
          message={`${confirmDelete.quantity}× ${confirmDelete.name} será removido da comanda. Essa ação não pode ser desfeita.`}
          confirmLabel="Remover"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDeleteConfirmed(confirmDelete)}
        />
      )}

      {printOpen && (
        <PrintLayoutModal
          onClose={() => setPrintOpen(false)}
          onPrint={handlePrint}
          busy={printing}
        />
      )}
    </div>
  );
}
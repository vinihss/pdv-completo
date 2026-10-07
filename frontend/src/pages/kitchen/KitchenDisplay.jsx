import React, { useState, useEffect, useCallback } from "react";
import { Check, Clock, Flame, ChefHat, PackageCheck, ClipboardList } from "lucide-react";
import { listOrders, updateItemStatus } from "@/entities/order";
import { listKitchenGroups } from "@/entities/kitchen-group";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { minutesSince, variationsText } from "@/shared/lib";
import { assetUrl } from "@/shared/lib/server";
import { EmptyState } from "@/shared/components";

// "3:20" — formato de cronômetro da tela da cozinha, não "3m 20s".
function formatMinSec(minutesFloat) {
  const totalSec = Math.floor(minutesFloat * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function KitchenDisplay() {
  const { session, storeSettings } = useAuth();
  const [tickets, setTickets] = useState([]); // achatado: um item de comanda = um ticket
  const [kitchenGroups, setKitchenGroups] = useState([]);
  const [activeGroup, setActiveGroup] = useState(null); // null = todas as estações
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState(null);

  const settings = storeSettings ?? { kitchenPrepWarnMin: 3, kitchenPrepUrgentMin: 6, kitchenPickupUrgentMin: 5 };

  const loadTickets = useCallback(async () => {
    const { data } = await listOrders("open");
    const flattened = [];
    for (const order of data) {
      const label = order.tableId ? `Mesa ${order.tableNumber ?? ""}`.trim() : order.customerName ?? order.tabLabel ?? "—";
      for (const item of order.items) {
        // Só itens de produção roteada: produto sem kitchen_group_id (bar/balcão)
        // não entra na fila da cozinha. A foto já vem no próprio item.
        if ((item.status === "ordered" || item.status === "ready") && item.kitchenGroupId) {
          // `orderNotes` é a observação do pedido INTEIRO (cliente, checkout
          // público) — instrução que vale para todos os itens, diferente de
          // `item.notes`, que é específica deste. Vai no ticket porque a cozinha
          // produz a partir do ticket, não da comanda.
          flattened.push({
            ...item,
            orderId: order.id,
            label,
            orderNotes: order.notes ?? "",
            imagePath: item.productImagePath ?? null,
          });
        }
      }
    }
    setTickets(flattened);
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    listKitchenGroups().then(setKitchenGroups).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const handleWsEvent = useCallback(
    (msg) => {
      if (msg.type === "order.item.created") showToast(`Novo pedido — ${msg.payload.item.name}`);
      loadTickets();
    },
    [loadTickets, showToast]
  );

  useRealtime(session?.token, ["kitchen-display"], handleWsEvent, loadTickets);

  async function markReady(ticket) {
    try {
      await updateItemStatus(ticket.orderId, ticket.id, "ready", ticket.version);
      await loadTickets();
    } catch {
      await loadTickets(); // conflito de versão — recarrega estado real
    }
  }

  const visible = activeGroup ? tickets.filter((t) => t.kitchenGroupId === activeGroup) : tickets;
  const preparing = visible.filter((t) => t.status === "ordered").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ready = visible.filter((t) => t.status === "ready").sort((a, b) => a.updatedAt?.localeCompare(b.updatedAt ?? "") ?? 0);

  const chipClass = (isActive) =>
    `shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${isActive ? "bg-amber-500 text-stone-950" : "bg-stone-800 border border-stone-700 text-stone-400 hover:bg-stone-750"}`;

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 flex flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b-2 border-stone-800 px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-amber-500 flex items-center justify-center">
            <ChefHat size={24} className="text-stone-950" strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-display text-xl font-bold leading-tight">Estação Cozinha</div>
            <div className="text-stone-500 text-sm">{settings.merchantName || "PDV"}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium text-stone-400 sm:gap-6">
          <span className="flex items-center gap-1.5"><Flame size={16} className="text-amber-400" /> {preparing.length} em preparo</span>
          <span className="flex items-center gap-1.5"><PackageCheck size={16} className="text-emerald-400" /> {ready.length} prontos</span>
        </div>
      </div>

      <div className="min-h-0 flex-[3] overflow-y-auto p-4 sm:p-6">
        {kitchenGroups.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-3 mb-2">
            <button onClick={() => setActiveGroup(null)} className={chipClass(!activeGroup)}>Todas</button>
            {kitchenGroups.map((g) => (
              <button key={g.id} onClick={() => setActiveGroup(g.id)} className={chipClass(activeGroup === g.id)}>
                {g.name}
              </button>
            ))}
          </div>
        )}
        <div className="ui-eyebrow mb-3 px-1">Em preparo</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3 2xl:grid-cols-4">
          {preparing.length === 0 && (
            <EmptyState
              icon={ClipboardList}
              title="Nenhum pedido em preparo"
              description="Os novos itens aparecerão aqui automaticamente."
              compact
              className="col-span-full"
            />
          )}
          {preparing.map((t) => {
            const elapsed = minutesSince(t.createdAt, now);
            const urgency = elapsed >= settings.kitchenPrepUrgentMin ? "urgent" : elapsed >= settings.kitchenPrepWarnMin ? "warn" : "fresh";
            const ringClass =
              urgency === "urgent" ? "border-red-500/70 bg-red-500/10" :
              urgency === "warn" ? "border-amber-500/60 bg-amber-500/5" :
              "border-stone-700 bg-stone-900";
            const timeClass = urgency === "urgent" ? "text-red-400" : urgency === "warn" ? "text-amber-400" : "text-stone-500";
            const variation = variationsText(t.selectedVariations);
            return (
              <button
                key={t.id}
                onClick={() => markReady(t)}
                className={`text-left rounded-2xl border-2 p-4 transition-transform active:scale-[.98] sm:p-5 ${ringClass} ${urgency === "urgent" ? "urgent-pulse" : ""}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <span className="font-display text-3xl font-extrabold leading-none">{t.quantity}×</span>
                  <span className={`flex items-center gap-1 text-sm font-bold tabular-nums ${timeClass}`}>
                    <Clock size={14} /> {formatMinSec(elapsed)}
                  </span>
                </div>
                {t.imagePath && (
                  <img src={assetUrl(t.imagePath)} alt={t.name} className="w-full h-20 object-cover rounded-xl mb-3" />
                )}
                <div className="font-display text-2xl font-bold leading-tight mb-1">{t.name}</div>
                {variation && <div className="text-stone-400 text-base mb-2">{variation}</div>}
                <div className="text-stone-500 text-sm font-medium mt-3">{t.label}</div>
                {t.orderNotes && (
                  <div className="text-amber-300 text-sm font-semibold mt-2 leading-snug border-t border-stone-700 pt-2">
                    OBS: {t.orderNotes}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-[1.4] overflow-y-auto border-t-2 border-stone-800 bg-stone-900/40 p-4 sm:p-6">
        <div className="ui-eyebrow mb-3 flex items-center gap-1.5 px-1 text-emerald-500">
          <PackageCheck size={13} /> Prontos — aguardando retirada
        </div>
        {ready.length === 0 && (
          <EmptyState
            icon={Check}
            title="Tudo em dia"
            description="Pedidos prontos para retirada aparecerão aqui."
            compact
          />
        )}
        <div className="flex gap-3 overflow-x-auto pb-1">
          {ready.map((t) => {
            const waiting = minutesSince(t.updatedAt ?? t.createdAt, now);
            const isUrgent = waiting >= settings.kitchenPickupUrgentMin;
            const variation = variationsText(t.selectedVariations);
            return (
              <div
                key={t.id}
                className={`shrink-0 w-56 rounded-2xl border-2 p-4 pop-anim ${
                  isUrgent ? "border-red-500/70 bg-red-500/10 urgent-pulse" : "border-emerald-600/50 bg-emerald-500/10"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <Check size={18} className="text-emerald-400" strokeWidth={3} />
                  <span className={`flex items-center gap-1 text-xs font-bold tabular-nums ${isUrgent ? "text-red-400" : "text-emerald-400"}`}>
                    <Clock size={12} /> {formatMinSec(waiting)}
                  </span>
                </div>
                {t.imagePath && (
                  <img src={assetUrl(t.imagePath)} alt={t.name} className="w-full h-16 object-cover rounded-lg mb-2" />
                )}
                <div className="font-display text-lg font-bold leading-tight">{t.quantity}× {t.name}</div>
                {variation && <div className="text-stone-400 text-sm">{variation}</div>}
                <div className="text-stone-500 text-xs font-medium mt-2">{t.label}</div>
                {t.orderNotes && (
                  <div className="text-amber-300 text-xs font-semibold mt-2 leading-snug">OBS: {t.orderNotes}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {toast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 bg-stone-800 border border-stone-700 px-5 py-3 rounded-xl shadow-2xl z-50 text-sm font-semibold toast-anim">
          {toast}
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useCallback } from "react";
import { Check, Clock, Flame, ChefHat, PackageCheck } from "lucide-react";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useRealtime } from "../lib/ws.js";

function toDate(ts) {
  if (!ts) return new Date();
  // SQLite CURRENT_TIMESTAMP vem como "YYYY-MM-DD HH:MM:SS" (sem T/Z);
  // updates explícitos gravam com toISOString() ("...T...Z"). Normaliza os dois.
  return ts.includes("T") ? new Date(ts) : new Date(ts.replace(" ", "T") + "Z");
}
function minutesSince(ts, now) {
  return Math.max(0, (now - toDate(ts).getTime()) / 60000);
}
function formatMinSec(minutesFloat) {
  const totalSec = Math.floor(minutesFloat * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function KitchenDisplay() {
  const { session, storeSettings } = useAuth();
  const [tickets, setTickets] = useState([]); // achatado: um item de comanda = um ticket
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState(null);

  const settings = storeSettings ?? { kitchenPrepWarnMin: 3, kitchenPrepUrgentMin: 6, kitchenPickupUrgentMin: 5 };

  const loadTickets = useCallback(async () => {
    const { data } = await api.listOrders("open");
    const flattened = [];
    for (const order of data) {
      const label = order.tableId ? `Mesa ${order.tableNumber ?? ""}`.trim() : order.customerName ?? order.tabLabel ?? "—";
      for (const item of order.items) {
        if (item.status === "ordered" || item.status === "ready") {
          flattened.push({ ...item, orderId: order.id, label });
        }
      }
    }
    setTickets(flattened);
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

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

  useRealtime(session?.token, ["kitchen-display"], handleWsEvent);

  async function markReady(ticket) {
    try {
      await api.updateItemStatus(ticket.orderId, ticket.id, "ready", ticket.version);
      await loadTickets();
    } catch {
      await loadTickets(); // conflito de versão — recarrega estado real
    }
  }

  const preparing = tickets.filter((t) => t.status === "ordered").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ready = tickets.filter((t) => t.status === "ready").sort((a, b) => a.updatedAt?.localeCompare(b.updatedAt ?? "") ?? 0);

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 flex flex-col">
      <div className="flex items-center justify-between px-8 py-5 border-b-2 border-stone-800 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-amber-500 flex items-center justify-center">
            <ChefHat size={24} className="text-stone-950" strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-display text-xl font-bold leading-tight">Estação Cozinha</div>
            <div className="text-stone-500 text-sm">{settings.merchantName || "Bar do Zé"}</div>
          </div>
        </div>
        <div className="flex items-center gap-6 text-stone-400 text-sm font-medium">
          <span className="flex items-center gap-1.5"><Flame size={16} className="text-amber-400" /> {preparing.length} em preparo</span>
          <span className="flex items-center gap-1.5"><PackageCheck size={16} className="text-emerald-400" /> {ready.length} prontos</span>
        </div>
      </div>

      <div className="flex-[3] overflow-y-auto p-6">
        <div className="text-stone-500 text-xs font-bold tracking-widest uppercase mb-3 px-1">Em preparo</div>
        {preparing.length === 0 && (
          <div className="h-full flex items-center justify-center text-stone-600 text-lg py-16">Nenhum pedido em preparo.</div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {preparing.map((t) => {
            const elapsed = minutesSince(t.createdAt, now);
            const urgency = elapsed >= settings.kitchenPrepUrgentMin ? "urgent" : elapsed >= settings.kitchenPrepWarnMin ? "warn" : "fresh";
            const ringClass =
              urgency === "urgent" ? "border-red-500/70 bg-red-500/10" :
              urgency === "warn" ? "border-amber-500/60 bg-amber-500/5" :
              "border-stone-700 bg-stone-900";
            const timeClass = urgency === "urgent" ? "text-red-400" : urgency === "warn" ? "text-amber-400" : "text-stone-500";
            const variation = Object.values(t.selectedVariations ?? {}).join(", ");
            return (
              <button
                key={t.id}
                onClick={() => markReady(t)}
                className={`text-left rounded-2xl border-2 p-5 transition-transform active:scale-95 ${ringClass} ${urgency === "urgent" ? "urgent-pulse" : ""}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <span className="font-display text-3xl font-extrabold leading-none">{t.quantity}×</span>
                  <span className={`flex items-center gap-1 text-sm font-bold tabular-nums ${timeClass}`}>
                    <Clock size={14} /> {formatMinSec(elapsed)}
                  </span>
                </div>
                <div className="font-display text-2xl font-bold leading-tight mb-1">{t.name}</div>
                {variation && <div className="text-stone-400 text-base mb-2">{variation}</div>}
                <div className="text-stone-500 text-sm font-medium mt-3">{t.label}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-[1.4] border-t-2 border-stone-800 bg-stone-900/40 overflow-y-auto p-6">
        <div className="text-emerald-500 text-xs font-bold tracking-widest uppercase mb-3 px-1 flex items-center gap-1.5">
          <PackageCheck size={13} /> Prontos — aguardando retirada
        </div>
        {ready.length === 0 && <div className="text-stone-600 text-base py-6 text-center">Nada aguardando retirada.</div>}
        <div className="flex gap-3 overflow-x-auto pb-1">
          {ready.map((t) => {
            const waiting = minutesSince(t.updatedAt ?? t.createdAt, now);
            const isUrgent = waiting >= settings.kitchenPickupUrgentMin;
            const variation = Object.values(t.selectedVariations ?? {}).join(", ");
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
                <div className="font-display text-lg font-bold leading-tight">{t.quantity}× {t.name}</div>
                {variation && <div className="text-stone-400 text-sm">{variation}</div>}
                <div className="text-stone-500 text-xs font-medium mt-2">{t.label}</div>
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

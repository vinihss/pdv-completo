import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, Zap, Check, List, LayoutGrid, Grid, AlertTriangle, RefreshCw } from "lucide-react";
import { formatBRL } from "@/shared/lib";
import {
  orderLabel,
  orderTotal,
  orderHasReady,
  orderAllDelivered,
  formatDateTime,
} from "@/entities/order";

const VIEW_MODES = [
  { id: "list", label: "Lista", icon: List },
  { id: "grid-small", label: "Grade pequena", icon: LayoutGrid },
  { id: "grid-large", label: "Grade grande", icon: Grid },
];

const GRID_CLASSES = {
  list: "grid-cols-1",
  "grid-small": "grid-cols-2",
  "grid-large": "grid-cols-2 md:grid-cols-4",
};

const PAGE_SIZE = 10;

function isOpenOver24h(order) {
  if (order.status !== "open" || !order.openedAt) return false;
  const opened = new Date(order.openedAt).getTime();
  if (Number.isNaN(opened)) return false;
  return Date.now() - opened > 24 * 60 * 60 * 1000;
}

export default function OrderListScreen({ orders, loading, kitchenEnabled, usesTables, filter, setFilter, search, setSearch, onOpenOrder, onNewOrder, onReloadAll }) {
  const [viewMode, setViewMode] = useState(() => {
    try {
      const saved = localStorage.getItem("orderListViewMode");
      return VIEW_MODES.some((m) => m.id === saved) ? saved : "list";
    } catch {
      return "list";
    }
  });
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem("orderListViewMode", viewMode);
    } catch {
      // persistência best-effort
    }
  }, [viewMode]);

  // Filtro/busca/modo mudou → volta para a primeira página.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, search, viewMode]);

  const chips = [
    { id: "open", label: "Abertas" },
    { id: "closed", label: "Fechadas" },
    ...(kitchenEnabled ? [{ id: "ready", label: "Com pronto", icon: Zap }] : []),
    ...(usesTables ? [{ id: "table", label: "Mesa" }] : []),
    { id: "customer", label: "Cliente" },
  ];

  const filtered = useMemo(
    () =>
      orders
        .filter((o) => {
          if (filter === "open" && o.status !== "open") return false;
          if (filter === "closed" && o.status !== "closed") return false;
          if (filter === "ready" && !orderHasReady(o)) return false;
          if (filter === "table" && !o.tableId) return false;
          if (filter === "customer" && o.tableId) return false;
          if (search) {
            const q = search.toLowerCase();
            if (!orderLabel(o).toLowerCase().includes(q)) return false;
          }
          return true;
        })
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "open" ? -1 : 1;
          const aTs = a.status === "closed" ? a.closedAt : a.openedAt;
          const bTs = b.status === "closed" ? b.closedAt : b.openedAt;
          return (bTs ?? "").localeCompare(aTs ?? "");
        }),
    [orders, filter, search]
  );

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => c + PAGE_SIZE);
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, visibleCount]);

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 pb-24">
      <div className="px-5 pt-6 pb-4 sticky top-14 bg-stone-950/95 backdrop-blur z-10 border-b border-stone-900">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-display text-xl font-bold">Comandas</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const idx = VIEW_MODES.findIndex((m) => m.id === viewMode);
                setViewMode(VIEW_MODES[(idx + 1) % VIEW_MODES.length].id);
              }}
              aria-label={`Modo de visualização: ${VIEW_MODES.find((m) => m.id === viewMode)?.label ?? "Lista"}`}
              title={`Modo de visualização: ${VIEW_MODES.find((m) => m.id === viewMode)?.label ?? "Lista"} — clique para alternar`}
              className="p-1.5 rounded-lg transition-colors text-stone-500 hover:text-stone-300"
            >
              {(() => {
                const current = VIEW_MODES.find((m) => m.id === viewMode) ?? VIEW_MODES[0];
                const Icon = current.icon;
                return <Icon size={16} />;
              })()}
            </button>
            <button
              onClick={onReloadAll}
              aria-label="Atualizar"
              className="p-1.5 rounded-lg text-stone-500 hover:text-stone-300 transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por mesa, cliente..."
            className="w-full bg-stone-900 border border-stone-800 rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:border-amber-500/50"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {chips.map((c) => (
              <button
                key={c.id}
                onClick={() => setFilter(c.id)}
                className={`shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                  filter === c.id ? "bg-amber-500 text-stone-950" : "bg-stone-900 border border-stone-800 text-stone-400"
                }`}
              >
                {c.icon && <c.icon size={12} />}
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="px-5 pt-4">
        {loading && orders.length === 0 && <div className="text-stone-600 text-center py-16">Carregando comandas…</div>}
        {!loading && filtered.length === 0 && (
          <div className="text-stone-600 text-center py-16">
            {filter === "closed"
              ? "Nenhuma comanda fechada encontrada."
              : filter === "all"
                ? "Nenhuma comanda encontrada."
                : "Nenhuma comanda aberta encontrada."}
          </div>
        )}
        <div className={`grid ${GRID_CLASSES[viewMode]} gap-3`}>
          {visible.map((o) => {
            const closed = o.status === "closed";
            const hasReady = orderHasReady(o);
            const allDelivered = orderAllDelivered(o);
            const stale = isOpenOver24h(o);
            return (
              <button
                key={o.id}
                onClick={() => !closed && onOpenOrder(o.id)}
                className={`text-left rounded-2xl border p-4 transition-colors ${
                  hasReady
                    ? "border-emerald-500/50 bg-emerald-500/5"
                    : closed
                      ? "border-stone-800 bg-stone-900/40 cursor-default"
                      : "border-stone-800 bg-stone-900 hover:bg-stone-850 active:scale-95"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-display text-lg font-bold flex items-center gap-1.5">
                    {orderLabel(o)}
                    {stale && (
                      <AlertTriangle
                        size={15}
                        className="text-amber-400"
                        title="Comanda aberta há mais de 24h"
                        aria-label="Comanda aberta há mais de 24h"
                      />
                    )}
                  </span>
                  <span className="text-stone-500 text-xs">{o.items.length} {o.items.length === 1 ? "item" : "itens"}</span>
                </div>
                {(o.channel === "whatsapp" || o.channel === "web") && (
                  <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 mb-1.5">
                    Delivery{o.channel === "whatsapp" ? " · WhatsApp" : ""}
                  </span>
                )}
                <div className="text-emerald-400 font-semibold text-sm mb-1">{formatBRL(orderTotal(o))}</div>
                <div className="text-stone-500 text-xs">
                  Aberta em {formatDateTime(o.openedAt)}
                  {closed && <span className="text-stone-600"> · Fechada em {formatDateTime(o.closedAt)}</span>}
                </div>
                {stale && (
                  <div className="mt-2 flex items-center gap-1 text-amber-400 text-xs font-semibold">
                    <AlertTriangle size={12} /> Aberta há mais de 24h
                  </div>
                )}
                {kitchenEnabled && hasReady && (
                  <div className="mt-2 flex items-center gap-1 text-emerald-400 text-xs font-semibold">
                    <Zap size={12} /> Pronto para entregar
                  </div>
                )}
                {kitchenEnabled && allDelivered && !hasReady && (
                  <div className="mt-2 flex items-center gap-1 text-stone-500 text-xs">
                    <Check size={12} /> Tudo entregue
                  </div>
                )}
              </button>
            );
          })}
        </div>
        {hasMore && <div ref={sentinelRef} className="h-8" aria-hidden="true" />}
      </div>

      <button
        onClick={onNewOrder}
        className="fixed bottom-20 right-5 z-30 bg-amber-500 hover:bg-amber-400 text-stone-950 rounded-full p-4 shadow-xl shadow-black/40 active:scale-95 transition-transform"
      >
        <Plus size={22} strokeWidth={2.5} />
      </button>
    </div>
  );
}

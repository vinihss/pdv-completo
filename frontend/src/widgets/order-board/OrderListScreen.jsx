import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, Zap, Check, List, LayoutGrid, Grid, AlertTriangle, RefreshCw } from "lucide-react";
import { formatBRL } from "@/shared/lib";
import {
  orderLabel,
  orderTotal,
  orderHasReady,
  orderAllDelivered,
  orderItemCounts,
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

// Formata tempo desde abertura em formato legível (ex: "5min", "1h 30min")
function formatTimeSince(dateString) {
  if (!dateString) return null;
  const opened = new Date(dateString).getTime();
  if (Number.isNaN(opened)) return null;
  
  const diffMs = Date.now() - opened;
  const diffMin = Math.floor(diffMs / 60000);
  
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `${diffMin}min`;
  
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
}

// Resumo operacional do cartão: estados em TEXTO, nunca só cor. A contagem é
// por linha de item (`orderItemCounts`), a mesma unidade do "N itens".
function workSummary(order, kitchenEnabled) {
  const { ordered, ready } = orderItemCounts(order);
  if (kitchenEnabled) {
    if (ready > 0 && ordered > 0) {
      return { text: `${ready} prontos · ${ordered} em preparo`, tone: "ready" };
    }
    if (ready > 0) {
      return { text: ready === 1 ? "1 pronto para entregar" : `${ready} prontos para entregar`, tone: "ready" };
    }
    if (ordered > 0) {
      return { text: `${ordered} em preparo`, tone: "pending" };
    }
    if (orderAllDelivered(order)) {
      return { text: "Tudo entregue", tone: "done" };
    }
    return null;
  }
  if (ordered > 0) {
    return { text: `${ordered} aguardando entrega`, tone: "pending" };
  }
  return null;
}

// Busca robusta: verifica número da mesa, nome do cliente e rótulo da comanda.
// Permite buscar por "12" e encontrar "Mesa 12", ou por "João" e encontrar
// comandas do cliente João, mesmo que o rótulo seja diferente.
function matchesSearch(order, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  
  // Busca por número da mesa (ex: "12" encontra "Mesa 12")
  if (order.tableNumber && String(order.tableNumber).toLowerCase().includes(q)) {
    return true;
  }
  
  // Busca por nome do cliente
  if (order.customerName && order.customerName.toLowerCase().includes(q)) {
    return true;
  }
  
  // Busca por rótulo da comanda
  if (orderLabel(order).toLowerCase().includes(q)) {
    return true;
  }
  
  return false;
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

  // Controle de visualização mais descobrível: menu com opções explícitas em
  // vez de botão cíclico que escondia as alternativas.
  const [viewMenuOpen, setViewMenuOpen] = useState(false);

  // Contagens dos chips vêm da lista COMPLETA (não da já filtrada), senão o
  // número mudaria conforme o filtro selecionado.
  const openCount = orders.filter((o) => o.status === "open").length;
  const readyCount = orders.filter((o) => o.status === "open" && orderHasReady(o)).length;

  const chips = [
    { id: "open", label: "Abertas", count: openCount },
    { id: "closed", label: "Fechadas" },
    ...(kitchenEnabled ? [{ id: "ready", label: "Com pronto", icon: Zap, count: readyCount }] : []),
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
          if (!matchesSearch(o, search)) return false;
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
    <div className="min-h-screen bg-stone-950 text-stone-50 pb-40">
      <div className="px-5 pt-6 pb-4 sticky top-14 bg-stone-950/95 backdrop-blur z-10 border-b border-stone-900">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-display text-xl font-bold">Comandas</h1>
          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                onClick={() => setViewMenuOpen(!viewMenuOpen)}
                aria-label={`Modo de visualização: ${VIEW_MODES.find((m) => m.id === viewMode)?.label ?? "Lista"}`}
                aria-expanded={viewMenuOpen}
                aria-haspopup="menu"
                className="p-1.5 rounded-lg transition-colors text-stone-500 hover:text-stone-300"
              >
                {(() => {
                  const current = VIEW_MODES.find((m) => m.id === viewMode) ?? VIEW_MODES[0];
                  const Icon = current.icon;
                  return <Icon size={16} />;
                })()}
              </button>
              {viewMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setViewMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    className="absolute right-0 top-full mt-1 z-30 bg-stone-900 border border-stone-700 rounded-lg shadow-lg py-1 min-w-[160px]"
                  >
                    {VIEW_MODES.map((mode) => {
                      const Icon = mode.icon;
                      return (
                        <button
                          key={mode.id}
                          role="menuitemradio"
                          aria-checked={viewMode === mode.id}
                          onClick={() => {
                            setViewMode(mode.id);
                            setViewMenuOpen(false);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                            viewMode === mode.id
                              ? "bg-amber-500/10 text-amber-400"
                              : "text-stone-300 hover:bg-stone-800"
                          }`}
                        >
                          <Icon size={16} />
                          {mode.label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={onReloadAll}
              aria-label="Atualizar"
              title="Atualizar"
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
                {c.count != null && (
                  <span
                    className={`ml-0.5 min-w-4 px-1 rounded-full text-[10px] leading-4 font-bold ${
                      filter === c.id ? "bg-stone-950/20 text-stone-900" : "bg-stone-800 text-stone-300"
                    }`}
                  >
                    {c.count}
                  </span>
                )}
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
            const summary = workSummary(o, kitchenEnabled);
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
                  {formatTimeSince(o.openedAt)} · {formatDateTime(o.openedAt)}
                  {closed && <span className="text-stone-600"> · Fechada em {formatDateTime(o.closedAt)}</span>}
                </div>
                {stale && (
                  <div className="mt-2 flex items-center gap-1 text-amber-400 text-xs font-semibold">
                    <AlertTriangle size={12} aria-hidden="true" /> Aberta há mais de 24h
                  </div>
                )}
                {summary && (
                  <div
                    className={`mt-2 flex items-center gap-1 text-xs ${
                      summary.tone === "ready"
                        ? "text-emerald-400 font-semibold"
                        : summary.tone === "done"
                          ? "text-stone-500"
                          : "text-stone-400"
                    }`}
                  >
                    {summary.tone === "ready" && <Zap size={12} aria-hidden="true" />}
                    {summary.tone === "done" && <Check size={12} aria-hidden="true" />}
                    {summary.text}
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
        aria-label="Nova comanda"
        title="Nova comanda"
        className="fixed bottom-20 right-5 z-30 bg-amber-500 hover:bg-amber-400 text-stone-950 rounded-full p-4 shadow-xl shadow-black/40 active:scale-95 transition-transform"
      >
        <Plus size={22} strokeWidth={2.5} />
      </button>
    </div>
  );
}

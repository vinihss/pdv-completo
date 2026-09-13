import React, { useState, useEffect } from "react";
import {
  Search, Plus, ChevronLeft, Check, Trash2, AlertTriangle,
  CreditCard, Banknote, QrCode, MoreHorizontal, X, Zap, Clock,
} from "lucide-react";
import { api } from "../lib/api.js";
import { buildPixPayload } from "../lib/pix.js";
import { useAuth } from "../context/AuthContext.jsx";
import QRCode from "qrcode";
import { useOrders } from "../lib/useOrders.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { useToast, Toast } from "../components/Toast.jsx";

function money(v) {
  return `R$ ${Number(v).toFixed(2)}`;
}

function toDate(ts) {
  if (!ts) return null;
  return ts.includes("T") ? new Date(ts) : new Date(ts.replace(" ", "T") + "Z");
}

function formatDateTime(ts) {
  const d = toDate(ts);
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function orderLabel(order) {
  if (order.tableId && order.tableNumber) return `Mesa ${order.tableNumber}`;
  if (order.tableId) return "Mesa";
  return order.customerName ?? order.tabLabel ?? "—";
}

function orderTotal(order) {
  return order.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0) + (order.deliveryFee ?? 0);
}

function orderHasReady(order) {
  return order.items.some((i) => i.status === "ready");
}
function orderAllDelivered(order) {
  return order.items.length > 0 && order.items.every((i) => i.status === "delivered");
}
function pendingItems(order) {
  return order.items.filter((i) => i.status !== "delivered" && i.status !== "cancelled");
}

// ============================================================
// Tela raiz: lista de comandas abertas
// ============================================================
export default function WaiterApp() {
  const { storeSettings } = useAuth();
  const { orders, loading, reloadAll, reloadOne, setOrders } = useOrders();
  const { toast, showToast } = useToast();
  const [openOrderId, setOpenOrderId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [newOrderOpen, setNewOrderOpen] = useState(false);

  const kitchenEnabled = storeSettings?.kitchenEnabled ?? true;
  const usesTables = storeSettings?.usesTables ?? true;

  const openOrder = orders.find((o) => o.id === openOrderId) ?? null;

  async function handleOpenNewOrder(identification) {
    try {
      const order = await api.openOrder(identification);
      setOrders((prev) => [order, ...prev]);
      setNewOrderOpen(false);
      setOpenOrderId(order.id);
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  if (openOrder) {
    return (
      <>
        <OrderDetailScreen
          order={openOrder}
          kitchenEnabled={kitchenEnabled}
          onBack={() => setOpenOrderId(null)}
          onReload={() => reloadOne(openOrder.id)}
          showToast={showToast}
        />
        <Toast toast={toast} />
      </>
    );
  }

  return (
    <>
      <OrdersListScreen
        orders={orders}
        loading={loading}
        kitchenEnabled={kitchenEnabled}
        usesTables={usesTables}
        filter={filter}
        setFilter={setFilter}
        search={search}
        setSearch={setSearch}
        onOpenOrder={setOpenOrderId}
        onNewOrder={() => setNewOrderOpen(true)}
        onReloadAll={reloadAll}
      />
      {newOrderOpen && (
        <NewOrderModal usesTables={usesTables} onClose={() => setNewOrderOpen(false)} onConfirm={handleOpenNewOrder} />
      )}
      <Toast toast={toast} />
    </>
  );
}

// ============================================================
// Lista de comandas
// ============================================================
function OrdersListScreen({ orders, loading, kitchenEnabled, usesTables, filter, setFilter, search, setSearch, onOpenOrder, onNewOrder, onReloadAll }) {
  const chips = [
    { id: "all", label: "Todas" },
    { id: "open", label: "Abertas" },
    { id: "closed", label: "Fechadas" },
    ...(kitchenEnabled ? [{ id: "ready", label: "Com pronto", icon: Zap }] : []),
    ...(usesTables ? [{ id: "table", label: "Mesa" }] : []),
    { id: "customer", label: "Cliente" },
  ];

  const filtered = orders
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
    });

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 pb-24">
      <div className="px-5 pt-6 pb-4 sticky top-12 bg-stone-950/95 backdrop-blur z-10 border-b border-stone-900">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-display text-xl font-bold">Comandas</h1>
          <button
            onClick={onReloadAll}
            className="text-stone-500 hover:text-stone-300 text-xs font-semibold"
          >
            Atualizar
          </button>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((o) => {
            const closed = o.status === "closed";
            const hasReady = orderHasReady(o);
            const allDelivered = orderAllDelivered(o);
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
                  <span className="font-display text-lg font-bold">{orderLabel(o)}</span>
                  <span className="text-stone-500 text-xs">{o.items.length} {o.items.length === 1 ? "item" : "itens"}</span>
                </div>
                {(o.channel === "whatsapp" || o.channel === "web") && (
                  <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 mb-1.5">
                    Delivery{o.channel === "whatsapp" ? " · WhatsApp" : ""}
                  </span>
                )}
                <div className="text-emerald-400 font-semibold text-sm mb-1">{money(orderTotal(o))}</div>
                <div className="text-stone-500 text-xs">
                  Aberta em {formatDateTime(o.openedAt)}
                  {closed && <span className="text-stone-600"> · Fechada em {formatDateTime(o.closedAt)}</span>}
                </div>
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

// ============================================================
// Modal: abrir nova comanda
// ============================================================
function NewOrderModal({ usesTables, onClose, onConfirm }) {
  const [mode, setMode] = useState(usesTables ? "table" : "tab");
  const [tableId, setTableId] = useState("");
  const [tables, setTables] = useState([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [tabLabel, setTabLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (usesTables) api.listTables().then(setTables).catch(() => {});
  }, [usesTables]);

  useEffect(() => {
    if (mode !== "customer" || !customerQuery) {
      setCustomerResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.searchCustomers(customerQuery).then(setCustomerResults).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [mode, customerQuery]);

  async function handleConfirm() {
    setError(null);
    let identification = {};
    if (mode === "table") {
      if (!tableId) return setError("Selecione uma mesa.");
      identification = { tableId };
    } else if (mode === "customer") {
      if (!selectedCustomer) return setError("Selecione ou cadastre um cliente.");
      identification = { customerId: selectedCustomer.id };
    } else {
      if (!tabLabel.trim()) return setError("Informe um rótulo para a comanda.");
      identification = { tabLabel: tabLabel.trim() };
    }
    setSubmitting(true);
    await onConfirm(identification);
    setSubmitting(false);
  }

  async function handleQuickCreateCustomer() {
    if (!customerQuery.trim()) return;
    const created = await api.createCustomer({ name: customerQuery.trim() });
    setSelectedCustomer(created);
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center sm:justify-center z-40">
      <div className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display text-lg font-bold">Nova comanda</h2>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-300">
            <X size={20} />
          </button>
        </div>

        <div className="flex gap-2 mb-5">
          {usesTables && (
            <button
              onClick={() => setMode("table")}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold ${mode === "table" ? "bg-amber-500 text-stone-950" : "bg-stone-800 text-stone-400"}`}
            >
              Mesa
            </button>
          )}
          <button
            onClick={() => setMode("customer")}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${mode === "customer" ? "bg-amber-500 text-stone-950" : "bg-stone-800 text-stone-400"}`}
          >
            Cliente
          </button>
          <button
            onClick={() => setMode("tab")}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${mode === "tab" ? "bg-amber-500 text-stone-950" : "bg-stone-800 text-stone-400"}`}
          >
            Rótulo
          </button>
        </div>

        {mode === "table" && (
          <div className="grid grid-cols-4 gap-2 mb-4">
            {tables.map((t) => (
              <button
                key={t.id}
                disabled={t.status === "occupied"}
                onClick={() => setTableId(t.id)}
                className={`py-3 rounded-xl font-display font-bold text-sm ${
                  tableId === t.id
                    ? "bg-amber-500 text-stone-950"
                    : t.status === "occupied"
                    ? "bg-stone-800/50 text-stone-700 cursor-not-allowed"
                    : "bg-stone-800 text-stone-200"
                }`}
              >
                {t.number}
              </button>
            ))}
          </div>
        )}

        {mode === "customer" && (
          <div className="mb-4">
            <input
              value={customerQuery}
              onChange={(e) => {
                setCustomerQuery(e.target.value);
                setSelectedCustomer(null);
              }}
              placeholder="Nome do cliente..."
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-amber-500/50 mb-2"
            />
            {selectedCustomer ? (
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm">
                <span>{selectedCustomer.name}</span>
                <button onClick={() => setSelectedCustomer(null)} className="text-stone-400">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCustomer(c)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone-800 text-sm"
                  >
                    {c.name} {c.phone ? <span className="text-stone-500">· {c.phone}</span> : null}
                  </button>
                ))}
                {customerQuery && customerResults.length === 0 && (
                  <button onClick={handleQuickCreateCustomer} className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone-800 text-sm text-amber-400">
                    + Cadastrar "{customerQuery}"
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {mode === "tab" && (
          <input
            value={tabLabel}
            onChange={(e) => setTabLabel(e.target.value)}
            placeholder="Ex: Comanda 12"
            className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-amber-500/50 mb-4"
          />
        )}

        {error && <div className="text-red-400 text-xs font-medium mb-3">{error}</div>}

        <button
          onClick={handleConfirm}
          disabled={submitting}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors"
        >
          {submitting ? "Abrindo…" : "Abrir comanda"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Detalhe da comanda: itens, adicionar, entregar, pagar, fechar
// ============================================================
function OrderDetailScreen({ order, kitchenEnabled, onBack, onReload, showToast }) {
  const { storeSettings } = useAuth();
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busyItemId, setBusyItemId] = useState(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);

  const pending = pendingItems(order);
  const canClose = pending.length === 0;

  async function handleItemTap(item) {
    if (item.status === "delivered" || item.status === "cancelled") return;
    const isDeliverable = kitchenEnabled ? item.status === "ready" : item.status === "ordered";
    if (!isDeliverable) return; // ainda em preparo, cozinha decide
    setBusyItemId(item.id);
    try {
      await api.updateItemStatus(order.id, item.id, "delivered", item.version);
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
      await api.deleteItem(order.id, item.id);
      await onReload();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleClose() {
    setCloseError(null);
    if (!canClose) return;
    if (!order.paymentMethod) {
      setPaymentOpen(true);
      return;
    }
    setClosing(true);
    try {
      await api.closeOrder(order.id);
      showToast("Comanda fechada.", "success");
      onBack();
    } catch (e) {
      if (e.code === "pending_items") {
        setCloseError("Ainda há itens pendentes: " + e.details.pendingItems.map((i) => i.name).join(", "));
      } else if (e.code === "payment_not_registered") {
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
          const canDelete = it.status !== "delivered";
          const variations = Object.values(it.selectedVariations ?? {}).join(", ");
          return (
            <div
              key={it.id}
              onClick={() => handleItemTap(it)}
              className={`py-3.5 flex items-center gap-3 ${
                isDeliverable ? "cursor-pointer ring-1 ring-emerald-500/40 -mx-3 px-3 rounded-xl" : ""
              } ${it.status === "delivered" ? "opacity-50" : ""}`}
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

      {order.paymentMethod && (
        <div className="px-5 pt-4">
          <div className="flex items-center gap-2 text-emerald-400 text-xs bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2.5">
            <Check size={14} /> Pagamento registrado: {order.paymentMethod}
          </div>
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
            {closing ? "Fechando…" : order.paymentMethod ? "Fechar conta" : "Registrar pagamento e fechar"}
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

// ============================================================
// Tela de adicionar item: carrinho → revisão → confirmação em lote
// ============================================================
function AddItemScreen({ order, onClose, onConfirmed, showToast }) {
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState({}); // productId -> { product, quantity, selectedVariations, notes }
  const [variationModal, setVariationModal] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api.listCategories().then(setCategories).catch(() => {});
    api.listProducts({ active: "true" }).then(({ data }) => setProducts(data)).catch(() => {});
  }, []);

  const filteredProducts = products.filter((p) => {
    if (activeCategory && p.categoryId !== activeCategory) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  function addToCart(product, selectedVariations = {}) {
    setCart((prev) => {
      const key = product.id + JSON.stringify(selectedVariations);
      const existing = prev[key];
      return { ...prev, [key]: { product, quantity: (existing?.quantity ?? 0) + 1, selectedVariations } };
    });
  }

  function handleProductTap(product) {
    if (product.variations?.length > 0) {
      setVariationModal(product);
    } else {
      addToCart(product);
    }
  }

  function cartQtyForProduct(productId) {
    return Object.values(cart)
      .filter((c) => c.product.id === productId)
      .reduce((sum, c) => sum + c.quantity, 0);
  }

  const cartLines = Object.values(cart);
  const cartCount = cartLines.reduce((sum, c) => sum + c.quantity, 0);
  const cartTotal = cartLines.reduce((sum, c) => sum + c.product.price * c.quantity, 0);

  async function handleConfirmBatch() {
    setConfirming(true);
    try {
      const items = cartLines.map((c) => ({
        productId: c.product.id,
        quantity: c.quantity,
        selectedVariations: c.selectedVariations,
      }));
      await api.addItems(order.id, items);
      setTimeout(async () => {
        setConfirming(false);
        await onConfirmed();
      }, 700);
    } catch (e) {
      setConfirming(false);
      showToast(e.message, "error");
    }
  }

  return (
    <div className="fixed inset-0 bg-stone-950 text-stone-50 z-40 flex flex-col">
      <div className="px-5 pt-6 pb-4 border-b border-stone-900 flex items-center gap-3 shrink-0">
        <button onClick={onClose} className="text-stone-400 hover:text-stone-200">
          <X size={20} />
        </button>
        <h1 className="font-display text-lg font-bold flex-1">Adicionar item</h1>
      </div>

      <div className="px-5 pt-4 shrink-0">
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar produto..."
            className="w-full bg-stone-900 border border-stone-800 rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:border-amber-500/50"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setActiveCategory(null)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${!activeCategory ? "bg-amber-500 text-stone-950" : "bg-stone-900 border border-stone-800 text-stone-400"}`}
          >
            Todos
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${activeCategory === c.id ? "bg-amber-500 text-stone-950" : "bg-stone-900 border border-stone-800 text-stone-400"}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto px-5 pt-4 ${cartCount > 0 ? "pb-24" : "pb-6"}`}>
        <div className="grid grid-cols-2 gap-3">
          {filteredProducts.map((p) => {
            const addedQty = cartQtyForProduct(p.id);
            return (
              <button
                key={p.id}
                onClick={() => handleProductTap(p)}
                className={`relative overflow-hidden text-left rounded-2xl p-4 border transition-all active:scale-95 ${
                  addedQty > 0 ? "bg-emerald-500/10 border-emerald-500/50" : "bg-stone-800 border-stone-700 hover:bg-stone-750"
                }`}
              >
                {addedQty > 0 && (
                  <span className="absolute top-2 right-2 bg-emerald-500 text-emerald-950 text-xs font-bold min-w-[1.5rem] h-6 px-1 rounded-full flex items-center justify-center shadow-lg pop-anim">
                    {addedQty}
                  </span>
                )}
                <div className="font-semibold text-sm mb-1 pr-6">{p.name}</div>
                <div className="text-emerald-400 text-sm font-bold">{money(p.price)}</div>
                {p.variations?.length > 0 && <div className="text-stone-500 text-xs mt-1">Opções disponíveis</div>}
              </button>
            );
          })}
          {filteredProducts.length === 0 && (
            <div className="col-span-2 text-stone-600 text-center py-12 text-sm">Nenhum produto encontrado.</div>
          )}
        </div>
      </div>

      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 border-t border-stone-800 bg-stone-900 z-30">
          <button
            onClick={() => setReviewOpen(true)}
            className="w-full flex items-center justify-between bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-semibold py-3.5 px-5 rounded-xl transition-colors"
          >
            <span className="flex items-center gap-2">
              <Check size={18} strokeWidth={2.5} />
              {cartCount} {cartCount === 1 ? "item" : "itens"} · {money(cartTotal)}
            </span>
            <span className="text-sm">Revisar e confirmar →</span>
          </button>
        </div>
      )}

      {variationModal && (
        <VariationModal
          product={variationModal}
          onClose={() => setVariationModal(null)}
          onConfirm={(variation) => {
            addToCart(variationModal, { opção: variation });
            setVariationModal(null);
          }}
        />
      )}

      {reviewOpen && (
        <ReviewCartModal
          lines={cartLines}
          total={cartTotal}
          onClose={() => setReviewOpen(false)}
          onRemoveLine={(key) => setCart((prev) => { const next = { ...prev }; delete next[key]; return next; })}
          onConfirm={handleConfirmBatch}
        />
      )}

      {confirming && (
        <div className="fixed inset-0 bg-stone-900/97 flex flex-col items-center justify-center z-50 pop-anim">
          <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center mb-4">
            <Check size={28} className="text-emerald-400" />
          </div>
          <div className="font-display text-lg font-bold">Itens adicionados!</div>
        </div>
      )}
    </div>
  );
}

function VariationModal({ product, onClose, onConfirm }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-xs bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-bold">{product.name}</h3>
          <button onClick={onClose} className="text-stone-500"><X size={18} /></button>
        </div>
        <div className="space-y-2">
          {product.variations.map((v) => (
            <button
              key={v}
              onClick={() => onConfirm(v)}
              className="w-full text-left px-4 py-3 rounded-xl bg-stone-800 hover:bg-stone-750 border border-stone-700 text-sm font-medium"
            >
              {v}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewCartModal({ lines, total, onClose, onRemoveLine, onConfirm }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 max-h-[85vh] flex flex-col fade-up">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h3 className="font-display text-lg font-bold">Revisar itens</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-2 mb-4">
          {Object.entries(lines).map(([, line], idx) => {
            const key = line.product.id + JSON.stringify(line.selectedVariations);
            const variation = Object.values(line.selectedVariations ?? {}).join(", ");
            return (
              <div key={key ?? idx} className="flex items-center justify-between bg-stone-800/60 rounded-xl px-3 py-2.5">
                <div>
                  <div className="text-sm font-semibold">{line.quantity}× {line.product.name}</div>
                  {variation && <div className="text-stone-500 text-xs">{variation}</div>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-emerald-400 text-sm font-semibold">{money(line.product.price * line.quantity)}</span>
                  <button onClick={() => onRemoveLine(key)} className="text-stone-600 hover:text-red-400">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between mb-4 pt-3 border-t border-stone-800 shrink-0">
          <span className="text-stone-400 text-sm">Total</span>
          <span className="font-display text-lg font-bold text-emerald-400">{money(total)}</span>
        </div>
        <button
          onClick={onConfirm}
          className="w-full bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors shrink-0"
        >
          Confirmar lançamento
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Pagamento
// ============================================================
const PAYMENT_META = {
  cash: { label: "Dinheiro", icon: Banknote },
  card: { label: "Cartão", icon: CreditCard },
  pix: { label: "Pix", icon: QrCode },
  other: { label: "Outro", icon: MoreHorizontal },
};

function PaymentModal({ order, enabledMethods, storeSettings, onClose, onConfirmed, showToast }) {
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
      await api.registerPayment(order.id, method, true);
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
      await api.registerPayment(order.id, "pix", false);
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

function PixQrScreen({ order, storeSettings, onBack, onConfirm, submitting }) {
  const [dataUrl, setDataUrl] = useState(null);
  const payload = buildPixPayload({
    pixKey: storeSettings.pixKey,
    merchantName: storeSettings.merchantName,
    merchantCity: storeSettings.merchantCity,
    amount: orderTotal(order),
    txid: order.id,
    description: orderLabel(order),
  });

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(payload, { width: 220, margin: 1 })
      .then((url) => alive && setDataUrl(url))
      .catch(() => alive && setDataUrl(null));
    return () => {
      alive = false;
    };
  }, [payload]);

  return (
    <div>
      <div className="text-center pt-1">
        <div className="text-stone-400 text-sm mb-1">Escaneie o QR com o app do banco</div>
        <div className="font-display text-3xl font-bold text-emerald-400">{money(orderTotal(order))}</div>
      </div>
      <div className="flex justify-center my-5">
        {dataUrl ? (
          <img src={dataUrl} alt="QR Code Pix" className="w-[220px] h-[220px] rounded-2xl bg-white p-2" />
        ) : (
          <div className="w-[220px] h-[220px] rounded-2xl bg-stone-800 animate-pulse" />
        )}
      </div>
      <div className="text-center text-xs text-stone-500 mb-4">
        Confira o recebimento no extrato do banco antes de confirmar.
      </div>
      <div className="flex gap-2">
        <button onClick={onBack} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-3 rounded-xl">
          Voltar
        </button>
        <button
          onClick={onConfirm}
          disabled={submitting}
          className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl"
        >
          {submitting ? "Confirmando…" : "Confirmar recebimento"}
        </button>
      </div>
    </div>
  );
}

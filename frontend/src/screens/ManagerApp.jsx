import React, { useState, useEffect, useCallback } from "react";
import {
  Receipt, Settings, Package, Users, BarChart3, History, Plus, Trash2,
  ChevronUp, ChevronDown, X, Check, RefreshCcw, AlertTriangle, Truck,
  Upload, ImageOff, UtensilsCrossed, Search, Eye, EyeOff, ChefHat, Store,
} from "lucide-react";
import { api } from "../lib/api.js";
import { formatBRL, maskCurrencyInput, parseBRL } from "../lib/money.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useDeliveries } from "../lib/useDeliveries.js";
import { applyBrandPrimary, DEFAULT_PRIMARY_COLOR } from "../lib/theme.js";
import WaiterApp from "./WaiterApp.jsx";
import { useToast, Toast } from "../components/Toast.jsx";

const TABS = [
  { id: "orders", label: "Comandas", icon: Receipt },
  { id: "deliveries", label: "Entregas", icon: Truck },
  { id: "catalog", label: "Cadastros", icon: Package },
  { id: "users", label: "Equipe", icon: Users },
  { id: "reports", label: "Relatórios", icon: BarChart3 },
  { id: "ifood", label: "iFood", icon: Store },
  { id: "audit", label: "Auditoria", icon: History },
  { id: "settings", label: "Configurações", icon: Settings },
];

export default function ManagerApp() {
  const [tab, setTab] = useState("orders");
  const { toast, showToast } = useToast();

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50">
      <div className="sticky top-12 z-20 bg-stone-950/95 backdrop-blur border-b border-stone-900 px-3 pt-3">
        <div className="flex gap-1 overflow-x-auto pb-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors ${
                tab === t.id ? "bg-amber-500 text-stone-950" : "bg-stone-900 border border-stone-800 text-stone-400"
              }`}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "orders" && <WaiterApp />}
      {tab === "deliveries" && <DeliveriesTab showToast={showToast} />}
      {tab === "catalog" && <CatalogTab showToast={showToast} />}
      {tab === "users" && <UsersTab showToast={showToast} />}
      {tab === "reports" && <ReportsTab showToast={showToast} />}
      {tab === "ifood" && <IfoodTab showToast={showToast} />}
      {tab === "audit" && <AuditTab showToast={showToast} />}
      {tab === "settings" && <SettingsTab showToast={showToast} />}
      <Toast toast={toast} />
    </div>
  );
}

// ============================================================
// Entregas — atribuição de entregador, status ao vivo via WebSocket
// (ver 04-delivery-self-service-integration.md e 05-delivery-api-contracts.md)
// ============================================================
const DELIVERY_STATUS_LABEL = { awaiting_courier: "Aguardando", out_for_delivery: "A caminho", delivered: "Entregue", failed: "Falhou" };
const DELIVERY_STATUS_CLASS = {
  awaiting_courier: "bg-amber-500/15 text-amber-400",
  out_for_delivery: "bg-sky-500/15 text-sky-400",
  delivered: "bg-emerald-500 text-emerald-950",
  failed: "bg-red-500/15 text-red-400",
};

function DeliveryStatusBadge({ status }) {
  return (
    <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${DELIVERY_STATUS_CLASS[status] ?? DELIVERY_STATUS_CLASS.awaiting_courier}`}>
      {DELIVERY_STATUS_LABEL[status] ?? status}
    </span>
  );
}

function DeliveriesTab({ showToast }) {
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
      await api.assignCourier(deliveryId, courierId);
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
      await api.cancelOrder(delivery.orderId, cancelReason.trim());
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

// ============================================================
// Configurações — store_settings
// ============================================================
function SettingsTab({ showToast }) {
  const { storeSettings, refreshStoreSettings } = useAuth();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [logoFile, setLogoFile] = useState(null); // arquivo staged (upload no salvar)
  const [logoPreview, setLogoPreview] = useState(""); // prévia staged (object URL)
  const [logoRemoved, setLogoRemoved] = useState(false); // remove o logo no salvar

  useEffect(() => {
    if (storeSettings) setForm(storeSettings);
  }, [storeSettings]);

  if (!form) return <div className="p-6 text-stone-600">Carregando…</div>;

  function set(patch) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function toggleMethod(m) {
    set({
      enabledPaymentMethods: form.enabledPaymentMethods.includes(m)
        ? form.enabledPaymentMethods.filter((x) => x !== m)
        : [...form.enabledPaymentMethods, m],
    });
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      await api.updateStoreSettings(form);
      if (logoFile) await api.uploadStoreLogo(logoFile);
      else if (logoRemoved) await api.removeStoreLogo();
      await refreshStoreSettings();
      setLogoFile(null);
      setLogoRemoved(false);
      showToast("Configurações salvas.", "success");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function handleLogoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoRemoved(false);
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  }

  function handleRemoveLogo() {
    setLogoFile(null);
    setLogoPreview("");
    setLogoRemoved(true);
  }

  const displayLogo = logoRemoved ? "" : logoPreview || form.logoUrl || "";

  return (
    <div className="p-5 max-w-lg mx-auto space-y-6">
      <Section title="Identidade">
        <Field label="Logo do restaurante">
          <div className="flex items-center gap-3">
            {displayLogo ? (
              <img src={displayLogo} alt="Logo do restaurante" className="w-16 h-16 rounded-xl object-cover shrink-0" />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-600 shrink-0">
                <Store size={24} />
              </div>
            )}
            <div className="flex-1 space-y-2">
              <label className="flex items-center justify-center gap-1.5 bg-stone-800 hover:bg-stone-750 border border-stone-700 rounded-xl px-3 py-2 text-sm font-medium cursor-pointer">
                <Upload size={14} /> {displayLogo ? "Trocar logo" : "Enviar logo"}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleLogoFile} />
              </label>
              {displayLogo && (
                <button onClick={handleRemoveLogo} className="flex items-center gap-1.5 text-red-400 text-xs font-medium">
                  <ImageOff size={13} /> Remover logo
                </button>
              )}
            </div>
          </div>
        </Field>
        <Field label="Cor principal (marca)">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={form.brandColor}
              onChange={(e) => {
                set({ brandColor: e.target.value });
                applyBrandPrimary(e.target.value);
              }}
              className="h-11 w-14 rounded-lg bg-stone-800 border border-stone-700 cursor-pointer shrink-0"
            />
            <span className="text-sm font-mono text-stone-400">{form.brandColor}</span>
            <button
              onClick={() => {
                set({ brandColor: DEFAULT_PRIMARY_COLOR });
                applyBrandPrimary();
              }}
              className="ml-auto flex items-center gap-1.5 bg-stone-800 hover:bg-stone-750 border border-stone-700 rounded-xl px-3 py-2 text-xs font-semibold text-stone-300 transition-colors"
            >
              <RefreshCcw size={13} /> Restaurar padrão
            </button>
          </div>
          <p className="text-stone-600 text-xs mt-1.5">Aplica nos botões principais, destaques e na página externa de pedidos.</p>
        </Field>
        <Field label="Nome do estabelecimento (máx. 25)">
          <input maxLength={25} value={form.merchantName} onChange={(e) => set({ merchantName: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Cidade (máx. 15)">
          <input maxLength={15} value={form.merchantCity} onChange={(e) => set({ merchantCity: e.target.value })} className={inputClass} />
        </Field>
      </Section>

      <Section title="Modo de operação">
        <ToggleRow label="Usa mesas" checked={form.usesTables} onChange={(v) => set({ usesTables: v })} />
        <ToggleRow label="Cozinha habilitada" checked={form.kitchenEnabled} onChange={(v) => set({ kitchenEnabled: v })} />
        <ToggleRow label="Integração iFood" checked={form.ifoodIntegrationEnabled} onChange={(v) => set({ ifoodIntegrationEnabled: v })} />
      </Section>

      <Section title="Entrega (WhatsApp / página externa)">
        <ToggleRow label="Usa delivery (página de pedido externa)" checked={form.usesDelivery} onChange={(v) => set({ usesDelivery: v })} />
        {form.usesDelivery && (
          <Field label="Taxa de entrega (R$)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.deliveryFee}
              onChange={(e) => set({ deliveryFee: Number(e.target.value) })}
              className={inputClass}
            />
          </Field>
        )}
      </Section>

      {form.kitchenEnabled && (
        <Section title="Limiares de tempo (cozinha)">
          <Field label="Alerta (preparo) — min">
            <input type="number" value={form.kitchenPrepWarnMin} onChange={(e) => set({ kitchenPrepWarnMin: Number(e.target.value) })} className={inputClass} />
          </Field>
          <Field label="Urgente (preparo) — min">
            <input type="number" value={form.kitchenPrepUrgentMin} onChange={(e) => set({ kitchenPrepUrgentMin: Number(e.target.value) })} className={inputClass} />
          </Field>
          <Field label="Urgente (retirada) — min">
            <input type="number" value={form.kitchenPickupUrgentMin} onChange={(e) => set({ kitchenPickupUrgentMin: Number(e.target.value) })} className={inputClass} />
          </Field>
        </Section>
      )}

      <Section title="Formas de pagamento">
        <div className="grid grid-cols-2 gap-2">
          {["cash", "card", "pix", "other"].map((m) => (
            <button
              key={m}
              onClick={() => toggleMethod(m)}
              className={`py-2.5 rounded-xl text-sm font-semibold border ${
                form.enabledPaymentMethods.includes(m) ? "bg-amber-500 text-stone-950 border-amber-500" : "bg-stone-900 border-stone-800 text-stone-400"
              }`}
            >
              {{ cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" }[m]}
            </button>
          ))}
        </div>
      </Section>

      {form.enabledPaymentMethods.includes("pix") && (
        <Section title="Pix (QR local)">
          <Field label="Chave Pix">
            <input value={form.pixKey} onChange={(e) => set({ pixKey: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Tipo da chave">
            <select value={form.pixKeyType} onChange={(e) => set({ pixKeyType: e.target.value })} className={inputClass}>
              {["cpf", "cnpj", "email", "phone", "random"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
        </Section>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2.5">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors"
      >
        {saving ? "Salvando…" : "Salvar configurações"}
      </button>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-stone-500 text-xs font-bold tracking-widest uppercase mb-3">{title}</div>
      <div className="bg-stone-900 border border-stone-800 rounded-2xl p-4 space-y-4">{children}</div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div>
      <div className="text-stone-400 text-xs font-medium mb-1.5">{label}</div>
      {children}
    </div>
  );
}
function ToggleRow({ label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`w-11 h-6 rounded-full transition-colors relative ${checked ? "bg-amber-500" : "bg-stone-700"}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}
const inputClass = "w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-amber-500/50";

// ============================================================
// Cadastros — categorias, grupos de produção e produtos
// ============================================================
function CatalogTab({ showToast }) {
  const { storeSettings } = useAuth();
  const kitchenEnabled = storeSettings?.kitchenEnabled ?? true;
  const [categories, setCategories] = useState([]);
  const [kitchenGroups, setKitchenGroups] = useState([]);
  const [products, setProducts] = useState([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newKitchenGroupName, setNewKitchenGroupName] = useState("");
  const [editingProduct, setEditingProduct] = useState(null); // null | "new" | product
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState(null);
  const [deleteKitchenGroupTarget, setDeleteKitchenGroupTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all"); // "all" | "uncategorized" | catId
  const [activeFilter, setActiveFilter] = useState("all"); // "all" | "active" | "inactive"

  const load = useCallback(async () => {
    const params = {};
    if (activeFilter === "active") params.active = "true";
    else if (activeFilter === "inactive") params.active = "false";
    if (categoryFilter !== "all" && categoryFilter !== "uncategorized") params.category_id = categoryFilter;
    if (search.trim()) params.q = search.trim();
    const [cats, groups, prods] = await Promise.all([
      api.listCategories(),
      api.listKitchenGroups(),
      api.listAllProducts(params),
    ]);
    setCategories(cats);
    setKitchenGroups(groups);
    setProducts(prods.data);
  }, [search, categoryFilter, activeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddCategory() {
    if (!newCategoryName.trim()) return;
    try {
      await api.createCategory({ name: newCategoryName.trim(), displayOrder: categories.length });
      setNewCategoryName("");
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleRenameCategory(cat, name) {
    try {
      await api.updateCategory(cat.id, { name });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleToggleCategoryActive(cat) {
    try {
      await api.updateCategory(cat.id, { active: !cat.active });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleReorder(cat, direction) {
    const sorted = [...categories].sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = sorted.findIndex((c) => c.id === cat.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    await Promise.all([
      api.updateCategory(cat.id, { displayOrder: other.displayOrder }),
      api.updateCategory(other.id, { displayOrder: cat.displayOrder }),
    ]);
    await load();
  }

  async function handleAddKitchenGroup() {
    if (!newKitchenGroupName.trim()) return;
    try {
      await api.createKitchenGroup({ name: newKitchenGroupName.trim(), displayOrder: kitchenGroups.length });
      setNewKitchenGroupName("");
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleRenameKitchenGroup(group, name) {
    try {
      await api.updateKitchenGroup(group.id, { name });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleReorderKitchenGroup(group, direction) {
    const sorted = [...kitchenGroups].sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = sorted.findIndex((c) => c.id === group.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    await Promise.all([
      api.updateKitchenGroup(group.id, { displayOrder: other.displayOrder }),
      api.updateKitchenGroup(other.id, { displayOrder: group.displayOrder }),
    ]);
    await load();
  }

  async function handleToggleProductActive(p) {
    try {
      await api.setProductActive(p.id, !p.active);
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  const productsLinked = (catId) => products.filter((p) => p.categoryId === catId).length;
  const productsInKitchenGroup = (groupId) => products.filter((p) => p.kitchenGroupId === groupId).length;

  async function handleDeleteCategory(cat) {
    try {
      await api.deleteCategory(cat.id);
      setDeleteCategoryTarget(null);
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleDeleteKitchenGroup(group) {
    try {
      await api.deleteKitchenGroup(group.id);
      setDeleteKitchenGroupTarget(null);
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  // "Sem categoria" só faz sentido fora do filtro por categoria específica;
  // busca/ativo já foram aplicados no servidor.
  const sortedProducts = [...products].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const categorized = sortedProducts.filter((p) => p.categoryId);
  const uncategorized =
    categoryFilter === "uncategorized"
      ? sortedProducts.filter((p) => !p.categoryId)
      : [];

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-6">
      <Section title="Categorias">
        <div className="space-y-2">
          {categories
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((cat) => (
              <div key={cat.id} className="flex items-center gap-2 bg-stone-800/60 rounded-xl px-3 py-2">
                <input
                  defaultValue={cat.name}
                  onBlur={(e) => e.target.value !== cat.name && handleRenameCategory(cat, e.target.value)}
                  className="flex-1 bg-transparent text-sm font-medium outline-none"
                />
                <button onClick={() => handleToggleCategoryActive(cat)} title={cat.active ? "Desativar" : "Ativar"} className="text-stone-500 hover:text-amber-400">
                  {cat.active ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
                <button onClick={() => handleReorder(cat, "up")} className="text-stone-500 hover:text-stone-300"><ChevronUp size={16} /></button>
                <button onClick={() => handleReorder(cat, "down")} className="text-stone-500 hover:text-stone-300"><ChevronDown size={16} /></button>
                <button onClick={() => setDeleteCategoryTarget(cat)} className="text-stone-500 hover:text-red-400"><Trash2 size={15} /></button>
              </div>
            ))}
        </div>
        <div className="flex gap-2 pt-2">
          <input
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="Nova categoria..."
            className={inputClass}
          />
          <button onClick={handleAddCategory} className="bg-amber-500 hover:bg-amber-400 text-stone-950 px-4 rounded-xl font-semibold shrink-0">
            <Plus size={16} />
          </button>
        </div>
        {categories.some((c) => !c.active) && (
          <p className="text-stone-600 text-xs">Categorias desativadas não aparecem no cardápio público, mas continuam no app do garçom.</p>
        )}
      </Section>

      {kitchenEnabled && (
        <Section title="Grupos de produção">
          <div className="space-y-2">
          {kitchenGroups
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((group) => (
              <div key={group.id} className="flex items-center gap-2 bg-stone-800/60 rounded-xl px-3 py-2">
                <ChefHat size={15} className="text-stone-600 shrink-0" />
                <input
                  defaultValue={group.name}
                  onBlur={(e) => e.target.value !== group.name && handleRenameKitchenGroup(group, e.target.value)}
                  className="flex-1 bg-transparent text-sm font-medium outline-none"
                />
                <button onClick={() => handleReorderKitchenGroup(group, "up")} className="text-stone-500 hover:text-stone-300"><ChevronUp size={16} /></button>
                <button onClick={() => handleReorderKitchenGroup(group, "down")} className="text-stone-500 hover:text-stone-300"><ChevronDown size={16} /></button>
                <button onClick={() => setDeleteKitchenGroupTarget(group)} className="text-stone-500 hover:text-red-400"><Trash2 size={15} /></button>
              </div>
            ))}
          {kitchenGroups.length === 0 && (
            <p className="text-stone-600 text-xs">Nenhum grupo cadastrado. Produtos sem grupo não entram no fluxo da cozinha.</p>
          )}
        </div>
        <div className="flex gap-2 pt-2">
          <input
            value={newKitchenGroupName}
            onChange={(e) => setNewKitchenGroupName(e.target.value)}
            placeholder="Novo grupo (ex.: Cozinha, Grelha, Bar)..."
            className={inputClass}
          />
          <button onClick={handleAddKitchenGroup} className="bg-amber-500 hover:bg-amber-400 text-stone-950 px-4 rounded-xl font-semibold shrink-0">
            <Plus size={16} />
          </button>
        </div>
      </Section>
    )}

    <Section title="Produtos">
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar produto..."
              className={inputClass + " pl-9"}
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className={inputClass + " w-auto shrink-0"}
          >
            <option value="all">Todas as categorias</option>
            <option value="uncategorized">Sem categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value)}
            className={inputClass + " w-auto shrink-0"}
          >
            <option value="all">Todos</option>
            <option value="active">Disponíveis</option>
            <option value="inactive">Indisponíveis</option>
          </select>
        </div>

        <div className="space-y-2">
          {categorized.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              categoryName={p.categoryName ?? "Sem categoria"}
              ifoodIntegrationEnabled={storeSettings?.ifoodIntegrationEnabled ?? false}
              kitchenEnabled={kitchenEnabled}
              onOpen={() => setEditingProduct(p)}
              onToggleActive={() => handleToggleProductActive(p)}
            />
          ))}

          {uncategorized.length > 0 && (
            <div className="pt-2">
              <div className="text-xs font-bold uppercase tracking-widest text-amber-500/80 mb-2 px-1">
                Sem categoria ({uncategorized.length}) — reatribua no formulário
              </div>
              {uncategorized.map((p) => (
                <ProductRow
                  key={p.id}
                  product={p}
                  categoryName="Sem categoria"
                  ifoodIntegrationEnabled={storeSettings?.ifoodIntegrationEnabled ?? false}
                  kitchenEnabled={kitchenEnabled}
                  onOpen={() => setEditingProduct(p)}
                  onToggleActive={() => handleToggleProductActive(p)}
                />
              ))}
            </div>
          )}

          {categorized.length === 0 && uncategorized.length === 0 && (
            <div className="text-stone-600 text-center py-12 text-sm">Nenhum produto encontrado.</div>
          )}
        </div>
        <button
          onClick={() => setEditingProduct("new")}
          className="w-full flex items-center justify-center gap-2 bg-stone-800 hover:bg-stone-750 border border-stone-700 text-sm font-semibold py-2.5 rounded-xl"
        >
          <Plus size={16} /> Novo produto
        </button>
      </Section>

      {editingProduct && (
        <ProductModal
          product={editingProduct === "new" ? null : editingProduct}
          categories={categories}
          kitchenGroups={kitchenGroups}
          kitchenEnabled={kitchenEnabled}
          ifoodIntegrationEnabled={storeSettings?.ifoodIntegrationEnabled ?? false}
          onClose={() => setEditingProduct(null)}
          onSaved={async () => {
            setEditingProduct(null);
            await load();
          }}
          showToast={showToast}
        />
      )}

      {deleteCategoryTarget && (
        <ConfirmModal
          title="Excluir categoria?"
          message={`"${deleteCategoryTarget.name}" será excluída. ${
            productsLinked(deleteCategoryTarget.id) > 0
              ? `${productsLinked(deleteCategoryTarget.id)} produto(s) ficarão sem categoria até reatribuição.`
              : "Nenhum produto está vinculado a ela."
          }`}
          confirmLabel="Excluir"
          onCancel={() => setDeleteCategoryTarget(null)}
          onConfirm={() => handleDeleteCategory(deleteCategoryTarget)}
        />
      )}

      {deleteKitchenGroupTarget && (
        <ConfirmModal
          title="Excluir grupo de produção?"
          message={`${productsInKitchenGroup(deleteKitchenGroupTarget.id)} produto(s) pararão de ir para a cozinha até reatribuição.`}
          confirmLabel="Excluir"
          onCancel={() => setDeleteKitchenGroupTarget(null)}
          onConfirm={() => handleDeleteKitchenGroup(deleteKitchenGroupTarget)}
        />
      )}
    </div>
  );
}

function ProductRow({ product: p, categoryName, onOpen, onToggleActive, ifoodIntegrationEnabled = false, kitchenEnabled = true }) {
  return (
    <button
      onClick={onOpen}
      className={`w-full flex items-center justify-between text-left px-3 py-2.5 rounded-xl ${p.active ? "bg-stone-800/60" : "bg-stone-800/20 opacity-50"}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {p.imagePath ? (
          <img src={p.imagePath} alt={p.name} className="w-10 h-10 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-stone-900 border border-stone-700 flex items-center justify-center text-stone-600 shrink-0">
            <Package size={18} />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium flex items-center gap-1.5">
            {p.name}
            {!p.active && (
              <span className="text-[10px] font-bold text-stone-500 bg-stone-700/60 rounded-full px-1.5 py-0.5">Indisponível</span>
            )}
            {ifoodIntegrationEnabled && p.ifoodEnabled && (
              <span className="flex items-center gap-0.5 text-[10px] font-bold text-red-400 bg-red-500/10 rounded-full px-1.5 py-0.5 shrink-0">
                <UtensilsCrossed size={10} /> iFood
              </span>
            )}
          </div>
          <div className="text-stone-500 text-xs truncate">
            {categoryName}
            {kitchenEnabled && p.kitchenGroupName ? ` · ${p.kitchenGroupName}` : ""}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-emerald-400 text-sm font-semibold">{formatBRL(p.price)}</span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onToggleActive();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              onToggleActive();
            }
          }}
          title={p.active ? "Desativar para venda" : "Ativar para venda"}
          className={`p-1 rounded-lg ${p.active ? "text-emerald-400 hover:text-amber-400" : "text-stone-600 hover:text-emerald-400"}`}
        >
          {p.active ? <Eye size={16} /> : <EyeOff size={16} />}
        </span>
      </div>
    </button>
  );
}

function ProductModal({ product, categories, kitchenGroups, kitchenEnabled, ifoodIntegrationEnabled, onClose, onSaved, showToast }) {
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(product ? formatBRL(product.price) : "");
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? "");
  const [kitchenGroupId, setKitchenGroupId] = useState(product?.kitchenGroupId ?? "");
  // Variações estruturadas: [{ name, options, required, allowMultiple }]
  const [variationGroups, setVariationGroups] = useState(() =>
    (product?.variations ?? []).map((g, i) => ({
      id: `g${i}`,
      name: g?.name ?? "",
      options: Array.isArray(g?.options) ? [...g.options] : [],
      required: Boolean(g?.required),
      allowMultiple: Boolean(g?.allowMultiple),
    }))
  );
  const [newOption, setNewOption] = useState({});
  const [active, setActive] = useState(product?.active ?? true);
  const [ifoodEnabled, setIfoodEnabled] = useState(product?.ifoodEnabled ?? false);
  const [ifoodSku, setIfoodSku] = useState(product?.ifoodSku ?? "");
  const [image, setImage] = useState({ file: null, preview: product?.imagePath ?? "" });
  const [removeImage, setRemoveImage] = useState(false);
  const [saving, setSaving] = useState(false);

  const categoryOptions = categories.filter((c) => c.active || c.id === product?.categoryId);

  function addVariationGroup() {
    setVariationGroups((prev) => [
      ...prev,
      { id: `g${Date.now()}`, name: "", options: [], required: false, allowMultiple: false },
    ]);
  }
  function updateVariationGroup(id, patch) {
    setVariationGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }
  function addOption(gi) {
    const value = newOption[gi]?.trim();
    if (!value) return;
    setVariationGroups((prev) =>
      prev.map((g, idx) => (idx === gi ? { ...g, options: [...g.options, value] } : g))
    );
    setNewOption((prev) => ({ ...prev, [gi]: "" }));
  }
  function removeOption(gi, oi) {
    setVariationGroups((prev) =>
      prev.map((g, idx) => (idx === gi ? { ...g, options: g.options.filter((_, i) => i !== oi) } : g))
    );
  }
  function removeVariationGroup(id) {
    setVariationGroups((prev) => prev.filter((g) => g.id !== id));
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRemoveImage(false);
    setImage({ file, preview: URL.createObjectURL(file) });
  }

  function handleRemoveImage() {
    setImage({ file: null, preview: "" });
    setRemoveImage(true);
  }

  async function handleSave() {
    if (!name.trim()) {
      showToast("Informe o nome do produto.", "error");
      return;
    }
    if (!categoryId && !product) {
      showToast("Crie ao menos uma categoria antes de cadastrar o produto.", "error");
      return;
    }
    setSaving(true);
    try {
      const variations = variationGroups
        .map((g) => ({
          name: g.name.trim(),
          options: g.options.map((o) => o.trim()).filter(Boolean),
          required: g.required,
          allowMultiple: g.allowMultiple,
        }))
        .filter((g) => g.name && g.options.length > 0);
      const body = {
        name: name.trim(),
        description: description.trim(),
        price: parseBRL(price),
        categoryId: categoryId || null,
        kitchenGroupId: kitchenEnabled ? kitchenGroupId || null : null,
        variations,
        active,
        ifoodEnabled: ifoodIntegrationEnabled ? ifoodEnabled : false,
        ifoodSku: ifoodIntegrationEnabled && ifoodEnabled ? ifoodSku.trim() : null,
      };
      let productId = product?.id;
      if (product) await api.updateProduct(product.id, body);
      else {
        const created = await api.createProduct(body);
        productId = created.id;
      }
      if (image.file) await api.uploadProductImage(productId, image.file);
      else if (removeImage) await api.removeProductImage(productId);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-md bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">{product ? "Editar produto" : "Novo produto"}</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="space-y-3 mb-5">
          <Field label="Foto do produto">
            <div className="flex items-center gap-3">
              {image.preview ? (
                <img src={image.preview} alt="Prévia do produto" className="w-16 h-16 rounded-xl object-cover shrink-0" />
              ) : (
                <div className="w-16 h-16 rounded-xl bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-600 shrink-0">
                  <Package size={24} />
                </div>
              )}
              <div className="flex-1 space-y-2">
                <label className="flex items-center justify-center gap-1.5 bg-stone-800 hover:bg-stone-750 border border-stone-700 rounded-xl px-3 py-2 text-sm font-medium cursor-pointer">
                  <Upload size={14} /> {image.file || product?.imagePath ? "Trocar foto" : "Enviar foto"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFileChange} />
                </label>
                {(image.file || product?.imagePath) && (
                  <button onClick={handleRemoveImage} className="flex items-center gap-1.5 text-red-400 text-xs font-medium">
                    <ImageOff size={13} /> Remover foto
                  </button>
                )}
              </div>
            </div>
          </Field>
          <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></Field>
          <Field label="Descrição"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Ex.: Prato do dia com arroz, feijão e salada..." className={inputClass + " resize-none"} /></Field>
          <Field label="Preço"><input inputMode="numeric" value={price} onChange={(e) => setPrice(maskCurrencyInput(e.target.value))} placeholder="R$ 0,00" className={inputClass} /></Field>
          <Field label="Categoria">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
              <option value="">{product ? "— Sem categoria —" : "Selecione uma categoria..."}</option>
              {categoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Grupo de produção (cozinha)">
            {kitchenEnabled ? (
              <>
                <select value={kitchenGroupId} onChange={(e) => setKitchenGroupId(e.target.value)} className={inputClass}>
                  <option value="">Nenhum — não vai para a cozinha</option>
                  {kitchenGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <div className="text-stone-600 text-xs mt-1">Itens deste produto só aparecem na tela da cozinha se um grupo for escolhido.</div>
              </>
            ) : (
              <div className="text-stone-600 text-xs bg-stone-800/50 border border-stone-800 rounded-xl px-3 py-2.5">
                Configuração atual: restaurante sem cozinha — este produto entra na comanda pronto, sem passagem por estação.
              </div>
            )}
          </Field>
          <Field label="Variações (opcional)">
            <div className="space-y-2">
              {variationGroups.map((g, gi) => (
                <div key={g.id} className="bg-stone-800/60 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={g.name}
                      onChange={(e) => updateVariationGroup(g.id, { name: e.target.value })}
                      placeholder="Nome do grupo (ex.: Ponto da carne)"
                      className="flex-1 bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-500/50"
                    />
                    <button onClick={() => removeVariationGroup(g.id)} className="text-stone-500 hover:text-red-400"><Trash2 size={15} /></button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.options.map((opt, oi) => (
                      <span key={oi} className="flex items-center gap-1 bg-stone-900 border border-stone-700 rounded-full pl-2.5 pr-1 py-1 text-xs">
                        {opt}
                        <button onClick={() => removeOption(gi, oi)} className="text-stone-500 hover:text-red-400"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={newOption[gi] ?? ""}
                      onChange={(e) => setNewOption((prev) => ({ ...prev, [gi]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(gi); } }}
                      placeholder="Nova opção (Enter para adicionar)..."
                      className="flex-1 bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-500/50"
                    />
                    <button onClick={() => addOption(gi)} className="bg-stone-900 border border-stone-700 rounded-lg px-2.5 text-stone-300 hover:text-amber-400"><Plus size={14} /></button>
                  </div>
                  <div className="flex gap-4 text-xs text-stone-400">
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={g.required} onChange={(e) => updateVariationGroup(g.id, { required: e.target.checked })} /> Obrigatória</label>
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={g.allowMultiple} onChange={(e) => updateVariationGroup(g.id, { allowMultiple: e.target.checked })} /> Permitir múltiplas</label>
                  </div>
                </div>
              ))}
              <button onClick={addVariationGroup} className="flex items-center gap-1.5 text-amber-500 text-sm font-semibold">
                <Plus size={14} /> Adicionar variação
              </button>
            </div>
          </Field>
          <div className="space-y-3 bg-stone-800/40 border border-stone-800 rounded-xl p-3">
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Habilitado para venda</div>
                  <div className="text-stone-600 text-xs">Desligado, o produto some das telas de venda (garçom, cardápio público e cozinha).</div>
                </div>
                <button
                  onClick={() => setActive(!active)}
                  className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${active ? "bg-amber-500" : "bg-stone-700"}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${active ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </div>
            </div>
            <div className="border-t border-stone-800 pt-3">
              {ifoodIntegrationEnabled ? (
                <ToggleRow label="Disponível no iFood" checked={ifoodEnabled} onChange={setIfoodEnabled} />
              ) : (
                <div className="text-stone-600 text-xs">
                  Integração com iFood desabilitada nas configurações — a flag não se aplica a este produto.
                </div>
              )}
            </div>
          </div>
          {ifoodIntegrationEnabled && ifoodEnabled && (
            <Field label="Código no iFood (SKU)">
              <input value={ifoodSku} onChange={(e) => setIfoodSku(e.target.value)} placeholder="Ex.: 5f3a0e1a-9d4c..." className={inputClass} />
            </Field>
          )}
        </div>
        <button onClick={handleSave} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl">
          {saving ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Equipe — usuários
// ============================================================
function UsersTab({ showToast }) {
  const [users, setUsers] = useState([]);
  const [newUserOpen, setNewUserOpen] = useState(false);
  const [revealedPin, setRevealedPin] = useState(null);

  const load = useCallback(async () => {
    setUsers(await api.listUsers());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleCreate(name, role) {
    const created = await api.createUser({ name, role });
    setRevealedPin({ name: created.name, pin: created.pin });
    setNewUserOpen(false);
    await load();
  }

  async function handleToggleActive(u) {
    await api.updateUser(u.id, { active: !u.active });
    await load();
  }

  async function handleResetPin(u) {
    const { pin } = await api.resetPin(u.id);
    setRevealedPin({ name: u.name, pin });
  }

  return (
    <div className="p-5 max-w-lg mx-auto space-y-4">
      <div className="space-y-2">
        {users.map((u) => (
          <div key={u.id} className={`flex items-center justify-between bg-stone-900 border border-stone-800 rounded-xl px-4 py-3 ${!u.active ? "opacity-50" : ""}`}>
            <div>
              <div className="text-sm font-semibold">{u.name}</div>
              <div className="text-stone-500 text-xs capitalize">{{ waiter: "Garçom", kitchen: "Cozinha", manager: "Gerente", courier: "Entregador" }[u.role]}</div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => handleResetPin(u)} className="text-stone-500 hover:text-amber-400" title="Redefinir PIN">
                <RefreshCcw size={15} />
              </button>
              <button onClick={() => handleToggleActive(u)} className="text-xs font-semibold text-stone-400 hover:text-stone-200">
                {u.active ? "Desativar" : "Ativar"}
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => setNewUserOpen(true)}
        className="w-full flex items-center justify-center gap-2 bg-stone-800 hover:bg-stone-750 border border-stone-700 text-sm font-semibold py-2.5 rounded-xl"
      >
        <Plus size={16} /> Novo usuário
      </button>

      {newUserOpen && <NewUserModal onClose={() => setNewUserOpen(false)} onCreate={handleCreate} />}

      {revealedPin && (
        <ConfirmModal
          title={`PIN de ${revealedPin.name}`}
          message={`PIN gerado: ${revealedPin.pin} — anote agora, não será mostrado de novo.`}
          confirmLabel="Ok, anotei"
          onCancel={() => setRevealedPin(null)}
          onConfirm={() => setRevealedPin(null)}
        />
      )}
    </div>
  );
}

function NewUserModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("waiter");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!name.trim()) return;
    setSaving(true);
    await onCreate(name.trim(), role);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-xs bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">Novo usuário</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></Field>
        <div className="my-3">
          <Field label="Perfil">
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>
              <option value="waiter">Garçom</option>
              <option value="kitchen">Cozinha</option>
              <option value="manager">Gerente</option>
              <option value="courier">Entregador</option>
            </select>
          </Field>
        </div>
        <button onClick={handleSubmit} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl">
          {saving ? "Criando…" : "Criar usuário"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Relatórios
// ============================================================
function ReportsTab({ showToast }) {
  const [report, setReport] = useState(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      if (customerQuery) params.customerQuery = customerQuery;
      setReport(await api.salesReport(params));
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, customerQuery]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="De"><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} /></Field>
        <Field label="Até"><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} /></Field>
      </div>
      <Field label="Cliente / mesa">
        <input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} placeholder="Buscar..." className={inputClass} />
      </Field>

      {loading && <div className="text-stone-600 text-center py-10">Carregando…</div>}

      {report && !loading && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Total vendido" value={`R$ ${report.summary.totalRevenue.toFixed(2)}`} />
            <StatCard label="Comandas" value={report.summary.orderCount} />
            <StatCard label="Ticket médio" value={`R$ ${report.summary.avgTicket.toFixed(2)}`} />
          </div>
          <Section title="Por forma de pagamento">
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(report.summary.byPaymentMethod).map(([m, v]) => (
                <div key={m} className="flex items-center justify-between text-sm">
                  <span className="text-stone-400 capitalize">{{ cash: "Dinheiro", card: "Cartão", pix: "Pix", other: "Outro" }[m]}</span>
                  <span className="font-semibold">R$ {v.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title={`Comandas fechadas (${report.total})`}>
            <div className="space-y-2">
              {report.data.map((o) => (
                <div key={o.orderId} className="flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium">{o.label}</div>
                    <div className="text-stone-500 text-xs">{o.closedAt} · {o.paymentMethod}</div>
                  </div>
                  <span className="text-emerald-400 font-semibold">R$ {o.total.toFixed(2)}</span>
                </div>
              ))}
              {report.data.length === 0 && <div className="text-stone-600 text-center py-6 text-sm">Nenhuma comanda no período.</div>}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
function StatCard({ label, value }) {
  return (
    <div className="bg-stone-900 border border-stone-800 rounded-xl p-3 text-center">
      <div className="text-stone-500 text-[11px] mb-1">{label}</div>
      <div className="font-display font-bold text-sm">{value}</div>
    </div>
  );
}

// ============================================================
// Auditoria
// ============================================================
const ACTION_LABEL = {
  order_opened: "Comanda aberta",
  item_added: "Item lançado",
  item_removed: "Item removido",
  item_ready: "Item marcado pronto",
  item_delivered: "Item entregue",
  payment_registered: "Pagamento registrado",
  order_closed: "Comanda fechada",
  product_created: "Produto criado",
  product_updated: "Produto atualizado",
  product_activated: "Produto ativado",
  product_deactivated: "Produto desativado",
  product_image_changed: "Foto do produto alterada",
  product_image_removed: "Foto do produto removida",
  category_created: "Categoria criada",
  category_updated: "Categoria atualizada",
  category_deleted: "Categoria excluída",
  kitchen_group_created: "Grupo de produção criado",
  kitchen_group_updated: "Grupo de produção atualizado",
  kitchen_group_deleted: "Grupo de produção excluído",
};

function AuditTab() {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    api.auditLog({ limit: 100 }).then((r) => setLogs(r.data));
  }, []);
  return (
    <div className="p-5 max-w-2xl mx-auto space-y-2">
      {logs.map((l) => (
        <div key={l.id} className="flex items-center justify-between bg-stone-900 border border-stone-800 rounded-xl px-4 py-2.5 text-sm">
          <div>
            <div className="font-medium">{ACTION_LABEL[l.action] ?? l.action}</div>
            <div className="text-stone-500 text-xs">{l.userName} · {l.createdAt}</div>
          </div>
        </div>
      ))}
      {logs.length === 0 && <div className="text-stone-600 text-center py-10">Sem eventos registrados.</div>}
    </div>
  );
}

// ============================================================
// iFood — status da integração + sincronização de catálogo
// ============================================================
function IfoodTab({ showToast }) {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => {
    api.getIfoodStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncIfoodCatalog();
      showToast(`Catálogo sincronizado (${r.items.sent} itens, ${r.categories} categorias)`, "success");
      refresh();
    } catch (e) {
      showToast(e?.message ?? "Falha ao sincronizar catálogo", "error");
    } finally {
      setSyncing(false);
    }
  };

  if (!status) {
    return (
      <div className="p-5 max-w-xl mx-auto text-center text-stone-500 py-12">
        Integração iFood não configurada (env/credenciais) ou indisponível.
      </div>
    );
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");

  return (
    <div className="p-5 max-w-xl mx-auto space-y-4">
      <div className="bg-stone-900 border border-stone-800 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm">Integração iFood</span>
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${status.enabled ? "bg-emerald-500 text-emerald-950" : "bg-red-500/15 text-red-400"}`}>
            {status.enabled ? "Ativa" : "Desativada"}
          </span>
        </div>
        {status.mock && <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5">Modo de demonstração (mock) — sem credenciais reais.</div>}
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-stone-500">Mercado</dt><dd>{status.merchantName ?? status.merchantId ?? "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-500">Último poll</dt><dd>{fmtTime(status.lastPollAt)}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-500">Catálogo (última sync)</dt><dd>{fmtTime(status.lastCatalogSyncAt)}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-500">Pedidos iFood locais</dt><dd>{status.ordersIngested}</dd></div>
        </dl>
        {status.lastPollError && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">Erro no poll: {status.lastPollError}</div>}
        {status.events && Object.keys(status.events).length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {Object.entries(status.events).map(([k, v]) => (
              <span key={k} className="bg-stone-800 rounded-full px-2 py-0.5 text-stone-400">{k}: <b className="text-stone-200">{v}</b></span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onSync}
        disabled={syncing}
        className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl flex items-center justify-center gap-2"
      >
        <RefreshCcw size={16} className={syncing ? "animate-spin" : ""} />
        {syncing ? "Sincronizando…" : "Sincronizar catálogo com o iFood"}
      </button>
    </div>
  );
}

// ============================================================
// Modal genérico de confirmação
// ============================================================
function ConfirmModal({ title, message, confirmLabel, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="w-full max-w-xs bg-stone-900 border border-stone-800 rounded-2xl p-5 fade-up">
        <div className="flex items-center gap-2 text-amber-400 mb-3">
          <AlertTriangle size={18} />
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <p className="text-stone-400 text-sm mb-5">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-2.5 rounded-xl">Cancelar</button>
          <button onClick={onConfirm} className="flex-1 bg-amber-500 hover:bg-amber-400 text-stone-950 font-semibold py-2.5 rounded-xl">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

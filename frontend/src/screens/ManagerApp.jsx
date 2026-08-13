import React, { useState, useEffect, useCallback } from "react";
import {
  Receipt, Settings, Package, Users, BarChart3, History, Plus, Trash2,
  ChevronUp, ChevronDown, X, Check, RefreshCcw, AlertTriangle,
} from "lucide-react";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import WaiterApp from "./WaiterApp.jsx";
import { useToast, Toast } from "../components/Toast.jsx";

const TABS = [
  { id: "orders", label: "Comandas", icon: Receipt },
  { id: "catalog", label: "Cadastros", icon: Package },
  { id: "users", label: "Equipe", icon: Users },
  { id: "reports", label: "Relatórios", icon: BarChart3 },
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
      {tab === "catalog" && <CatalogTab showToast={showToast} />}
      {tab === "users" && <UsersTab showToast={showToast} />}
      {tab === "reports" && <ReportsTab showToast={showToast} />}
      {tab === "audit" && <AuditTab showToast={showToast} />}
      {tab === "settings" && <SettingsTab showToast={showToast} />}
      <Toast toast={toast} />
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
      await refreshStoreSettings();
      showToast("Configurações salvas.", "success");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-5 max-w-lg mx-auto space-y-6">
      <Section title="Identidade">
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
// Cadastros — categorias e produtos
// ============================================================
function CatalogTab({ showToast }) {
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingProduct, setEditingProduct] = useState(null); // null | "new" | product
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState(null);

  const load = useCallback(async () => {
    const [cats, prods] = await Promise.all([api.listCategories(), api.listProducts({})]);
    setCategories(cats);
    setProducts(prods.data);
  }, []);

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

  const productsLinked = (catId) => products.filter((p) => p.categoryId === catId).length;

  async function handleDeleteCategory(cat) {
    try {
      await api.deleteCategory(cat.id);
      setDeleteCategoryTarget(null);
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

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
      </Section>

      <Section title="Produtos">
        <div className="space-y-2">
          {products.map((p) => (
            <button
              key={p.id}
              onClick={() => setEditingProduct(p)}
              className={`w-full flex items-center justify-between text-left px-3 py-2.5 rounded-xl ${p.active ? "bg-stone-800/60" : "bg-stone-800/20 opacity-50"}`}
            >
              <div>
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-stone-500 text-xs">{categories.find((c) => c.id === p.categoryId)?.name ?? "Sem categoria"}</div>
              </div>
              <div className="text-emerald-400 text-sm font-semibold">R$ {p.price.toFixed(2)}</div>
            </button>
          ))}
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
    </div>
  );
}

function ProductModal({ product, categories, onClose, onSaved, showToast }) {
  const [name, setName] = useState(product?.name ?? "");
  const [price, setPrice] = useState(product?.price ?? "");
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? categories[0]?.id ?? "");
  const [variations, setVariations] = useState((product?.variations ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        price: Number(price),
        categoryId,
        variations: variations.split(",").map((v) => v.trim()).filter(Boolean),
      };
      if (product) await api.updateProduct(product.id, body);
      else await api.createProduct(body);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive() {
    await api.setProductActive(product.id, !product.active);
    await onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center sm:justify-center z-50">
      <div className="w-full sm:max-w-sm bg-stone-900 border border-stone-800 rounded-t-3xl sm:rounded-3xl p-6 fade-up">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold">{product ? "Editar produto" : "Novo produto"}</h3>
          <button onClick={onClose} className="text-stone-500"><X size={20} /></button>
        </div>
        <div className="space-y-3 mb-5">
          <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></Field>
          <Field label="Preço"><input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className={inputClass} /></Field>
          <Field label="Categoria">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Variações (separadas por vírgula)">
            <input value={variations} onChange={(e) => setVariations(e.target.value)} placeholder="Ao ponto, Mal passado..." className={inputClass} />
          </Field>
        </div>
        <div className="flex gap-2">
          {product && (
            <button onClick={handleToggleActive} className="flex-1 bg-stone-800 text-stone-300 font-semibold py-3 rounded-xl text-sm">
              {product.active ? "Desativar" : "Ativar"}
            </button>
          )}
          <button onClick={handleSave} disabled={saving} className="flex-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl">
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </div>
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
              <div className="text-stone-500 text-xs capitalize">{{ waiter: "Garçom", kitchen: "Cozinha", manager: "Gerente" }[u.role]}</div>
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

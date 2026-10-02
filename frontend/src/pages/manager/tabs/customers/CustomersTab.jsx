import React, { useState, useCallback, useEffect } from "react";
import { Plus, Search, X, Star } from "lucide-react";
import { listAllCustomers, updateCustomer } from "@/entities/customer";
import { inputClass, Section } from "@/shared/components";
import { maskPhone, initials } from "@/shared/lib";
import { assetUrl } from "@/shared/lib/server";
import CustomerModal from "./CustomerModal.jsx";
import CustomerDetailScreen from "./CustomerDetailScreen.jsx";

/**
 * Lista de clientes — a tela de quem mantém o cadastro (gerente e caixa).
 *
 * Não existe rota por URL no app: quem troca de tela é o `NavProvider`
 * (`activeId`). A ficha do cliente é o **único** lugar que ganhou estado local
 * aqui (`selectedId`), justamente para não mexer no `NavProvider` — assim ela
 * funciona igual no `ManagerApp` e no `CashierApp`, que importam este mesmo
 * componente.
 */
export default function CustomersTab({ showToast }) {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = showInactive ? {} : { active: "true" };
      const { data } = await listAllCustomers(params);
      setCustomers(data);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
  }, [showInactive, showToast]);
  useEffect(() => { load(); }, [load]);

  async function handleToggleActive(c) {
    try {
      await updateCustomer(c.id, { active: !c.active });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  const filtered = customers.filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      (c.phone ?? "").includes(q.replace(/\D/g, "")) ||
      (c.email ?? "").toLowerCase().includes(q)
    );
  });

  if (selectedId) {
    return (
      <CustomerDetailScreen
        customerId={selectedId}
        seed={customers.find((c) => c.id === selectedId) ?? null}
        onBack={() => {
          setSelectedId(null);
          // Voltar é recarregar: a ficha pode ter editado nome, foto ou
          // situação, e a lista não faz cache — ela é a fonte da verdade.
          load();
        }}
        showToast={showToast}
      />
    );
  }

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-4">
      <Section title={`Clientes (${filtered.length})`}>
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, telefone ou email..."
              className={inputClass + " pl-9"}
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Limpar busca"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-stone-400 shrink-0 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-amber-500"
            />
            Mostrar inativos
          </label>
        </div>

        <div className="space-y-2">
          {filtered.map((c) => (
            <CustomerCard
              key={c.id}
              customer={c}
              onOpen={() => setSelectedId(c.id)}
              onToggleActive={() => handleToggleActive(c)}
            />
          ))}
          {!loading && filtered.length === 0 && (
            <div className="text-stone-600 text-center py-12 text-sm">
              {search ? "Nenhum cliente encontrado para a busca." : "Nenhum cliente cadastrado ainda."}
            </div>
          )}
        </div>

        <button
          onClick={() => { setEditingCustomer(null); setModalOpen(true); }}
          className="w-full flex items-center justify-center gap-2 bg-stone-800 hover:bg-stone-750 border border-stone-700 text-sm font-semibold py-2.5 rounded-xl"
        >
          <Plus size={16} /> Novo cliente
        </button>
      </Section>

      {modalOpen && (
        <CustomerModal
          customer={editingCustomer}
          onClose={() => setModalOpen(false)}
          onSaved={async () => {
            setModalOpen(false);
            await load();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

/**
 * Card clicável: abre a ficha do cliente.
 *
 * O card inteiro é alvo (`role="button"` + `tabIndex`) em vez de ter um ícone
 * de lápis dentro — o lápis virou o botão "Editar" da ficha, no canto superior
 * direito. Enter e Espaço abrem, senão o card fica inalcançável pelo teclado.
 * O botão de ativar/desativar para a propagação do clique e do `keydown`: sem
 * isso, Espaço nele abriria a ficha em vez de desativar o cliente.
 */
function CustomerCard({ customer: c, onOpen, onToggleActive }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
      aria-label={`Ver ficha de ${c.name}`}
      className={`w-full text-left flex items-center gap-3 bg-stone-900 border border-stone-800 rounded-xl px-4 py-3 cursor-pointer transition-colors hover:border-amber-500/50 hover:bg-stone-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 ${!c.active ? "opacity-50" : ""}`}
    >
      <div className="w-11 h-11 rounded-full bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-400 font-bold shrink-0 overflow-hidden">
        {c.photoPath ? (
          <img src={assetUrl(c.photoPath)} alt="" className="w-full h-full object-cover" />
        ) : (
          initials(c.name)
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold truncate">{c.name}</span>
          {c.addressCount > 0 && <Star size={11} className="text-amber-400 shrink-0" />}
        </div>
        <div className="text-stone-500 text-xs truncate">
          {[c.phone ? maskPhone(c.phone) : null, c.email].filter(Boolean).join(" · ") || "Sem contato"}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onToggleActive(); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
        className="text-xs font-semibold text-stone-400 hover:text-stone-200 px-2 py-1 shrink-0"
      >
        {c.active ? "Desativar" : "Ativar"}
      </button>
    </div>
  );
}

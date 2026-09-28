import React, { useState, useCallback, useEffect } from "react";
import { Plus, RefreshCcw, Search, X } from "lucide-react";
import { listUsers, updateUser, resetPin } from "@/entities/user";
import { ConfirmModal, inputClass, Section } from "@/shared/components";
import { initials, maskPhone } from "@/shared/lib";
import UserModal from "./UserModal.jsx";

const ROLE_LABEL = { waiter: "Garçom", kitchen: "Cozinha", manager: "Gerente", courier: "Entregador", cashier: "Caixa" };
const ROLE_BADGE = {
  waiter: "bg-sky-500/15 text-sky-400",
  kitchen: "bg-orange-500/15 text-orange-400",
  manager: "bg-amber-500/15 text-amber-400",
  courier: "bg-violet-500/15 text-violet-400",
  cashier: "bg-emerald-500/15 text-emerald-400",
};

export default function UsersTab({ showToast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [revealedPin, setRevealedPin] = useState(null);

  const load = useCallback(async () => {
    try {
      setUsers(await listUsers());
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  async function handleToggleActive(u) {
    try {
      await updateUser(u.id, { active: !u.active });
      await load();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleResetPin(u) {
    try {
      const { pin } = await resetPin(u.id);
      setRevealedPin({ name: u.name, pin });
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  const filtered = users.filter((u) => {
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      u.name.toLowerCase().includes(q) ||
      (u.phone ?? "").includes(q.replace(/\D/g, "")) ||
      (u.email ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-4">
      <Section title={`Equipe (${filtered.length})`}>
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
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className={inputClass + " w-auto shrink-0"}
          >
            <option value="all">Todos os perfis</option>
            {Object.entries(ROLE_LABEL).map(([r, label]) => (
              <option key={r} value={r}>{label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          {filtered.map((u) => (
            <div
              key={u.id}
              className={`flex items-center gap-3 bg-stone-900 border border-stone-800 rounded-xl px-4 py-3 ${!u.active ? "opacity-50" : ""}`}
            >
              {u.photoPath ? (
                <img src={u.photoPath} alt={u.name} className="w-11 h-11 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-11 h-11 rounded-full bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-400 font-bold shrink-0">
                  {initials(u.name)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold truncate">{u.name}</span>
                  <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 ${ROLE_BADGE[u.role] ?? ""}`}>
                    {ROLE_LABEL[u.role] ?? u.role}
                  </span>
                </div>
                <div className="text-stone-500 text-xs truncate">
                  {[u.phone ? maskPhone(u.phone) : null, u.email].filter(Boolean).join(" · ") || "Sem contato"}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => { setEditingUser(u); setModalOpen(true); }}
                  className="text-xs font-semibold text-stone-400 hover:text-amber-400 px-2 py-1"
                >
                  Editar
                </button>
                <button
                  onClick={() => handleResetPin(u)}
                  className="text-stone-500 hover:text-amber-400 p-1.5"
                  title="Redefinir PIN"
                >
                  <RefreshCcw size={15} />
                </button>
                <button
                  onClick={() => handleToggleActive(u)}
                  className="text-xs font-semibold text-stone-400 hover:text-stone-200 px-2 py-1"
                >
                  {u.active ? "Desativar" : "Ativar"}
                </button>
              </div>
            </div>
          ))}
          {!loading && filtered.length === 0 && (
            <div className="text-stone-600 text-center py-12 text-sm">Nenhum usuário encontrado.</div>
          )}
        </div>

        <button
          onClick={() => { setEditingUser(null); setModalOpen(true); }}
          className="w-full flex items-center justify-center gap-2 bg-stone-800 hover:bg-stone-750 border border-stone-700 text-sm font-semibold py-2.5 rounded-xl"
        >
          <Plus size={16} /> Novo usuário
        </button>
      </Section>

      {modalOpen && (
        <UserModal
          user={editingUser}
          onClose={() => setModalOpen(false)}
          onSaved={async () => {
            setModalOpen(false);
            await load();
          }}
          showToast={showToast}
        />
      )}

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

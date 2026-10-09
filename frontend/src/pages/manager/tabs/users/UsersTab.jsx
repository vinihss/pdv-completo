import React, { useState, useCallback, useEffect } from "react";
import { Pencil, Plus, RefreshCcw, UserX, UserCheck } from "lucide-react";
import { listUsers, updateUser, resetPin } from "@/entities/user";
import { ConfirmModal, UserAvatar } from "@/shared/components";
import UserModal from "./UserModal.jsx";

const ROLE_LABEL = { waiter: "Garçom", kitchen: "Cozinha", manager: "Gerente", courier: "Entregador", cashier: "Caixa" };

export default function UsersTab({ showToast }) {
  const [users, setUsers] = useState([]);
  const [filterRole, setFilterRole] = useState("all");
  const [newUserOpen, setNewUserOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [revealedPin, setRevealedPin] = useState(null);

  const load = useCallback(async () => {
    setUsers(await listUsers());
  }, []);
  useEffect(() => { load(); }, [load]);

  // onSaved do UserModal: recarrega a lista (mutation `await` + reload, sem
  // otimismo). Em criação o backend devolve o PIN gerado UMA única vez no
  // corpo da resposta — `saved.pin` só existe aí (edição e upload de foto
  // nunca devolvem pin), então o modal de PIN revelado só abre nesse caso.
  async function handleSaved(saved) {
    if (saved?.pin) setRevealedPin({ name: saved.name, pin: saved.pin });
    try {
      await load();
    } catch (e) {
      // A mutação já foi confirmada. Não manter o modal aberto para evitar
      // que a pessoa tente criar o mesmo usuário novamente por engano.
      showToast(`Salvo, mas não foi possível atualizar a lista: ${e.message}`, "error");
    }
  }

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

  const filteredUsers = filterRole === "all" ? users : users.filter((u) => u.role === filterRole);

  return (
    <div className="p-5 max-w-lg mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <label htmlFor="user-filter" className="text-xs text-stone-500 font-medium">Perfil:</label>
        <select
          id="user-filter"
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value)}
          className="text-xs bg-stone-800 border border-stone-700 rounded-lg px-2 py-1 text-stone-300 focus:outline-none focus:ring-1 focus:ring-amber-500 cursor-pointer"
        >
          <option value="all">Todos</option>
          <option value="waiter">Garçom</option>
          <option value="kitchen">Cozinha</option>
          <option value="manager">Gerente</option>
          <option value="cashier">Caixa</option>
          <option value="courier">Entregador</option>
        </select>
      </div>
      <div className="space-y-2">
        {filteredUsers.map((u) => (
          <div key={u.id} className={`flex items-center justify-between gap-3 bg-stone-900 border border-stone-800 rounded-xl px-4 py-3 ${!u.active ? "opacity-50" : ""}`}>
            <div className="flex items-center gap-3 min-w-0">
              <UserAvatar name={u.name} photoPath={u.photoPath} className="w-9 h-9 text-xs" />
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{u.name}</div>
                <div className="text-stone-500 text-xs">{ROLE_LABEL[u.role]}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button onClick={() => setEditing(u)} title="Editar usuário" aria-label={`Editar ${u.name}`} className="text-stone-500 hover:text-amber-400 cursor-pointer">
                <Pencil size={15} />
              </button>
              <button onClick={() => handleResetPin(u)} className="text-stone-500 hover:text-amber-400 cursor-pointer" title="Redefinir PIN" aria-label={`Redefinir PIN de ${u.name}`}>
                <RefreshCcw size={15} />
              </button>
              <button onClick={() => handleToggleActive(u)} className="text-stone-500 hover:text-amber-400 cursor-pointer" title={u.active ? "Desativar usuário" : "Ativar usuário"} aria-label={u.active ? `Desativar ${u.name}` : `Ativar ${u.name}`}>
                {u.active ? <UserX size={15} /> : <UserCheck size={15} />}
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

      {newUserOpen && (
        <UserModal
          onClose={() => setNewUserOpen(false)}
          onSaved={handleSaved}
          showToast={showToast}
        />
      )}
      {editing && (
        <UserModal
          key={editing.id}
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
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

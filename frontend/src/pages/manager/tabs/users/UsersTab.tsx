import { listUsers, resetPin, updateUser } from "@/entities/user";
import { ConfirmModal, TabbedWorkspace, UserAvatar } from "@/shared/components";
import { Pencil, Plus, RefreshCcw, UserCheck, UserX } from "lucide-react";
import React, { useState, useCallback, useEffect } from "react";
import UserModal from "./UserModal.jsx";

const ROLE_LABEL = {
  waiter: "Garçom",
  kitchen: "Cozinha",
  manager: "Gerente",
  courier: "Entregador",
  cashier: "Caixa",
};
const ROLE_TABS = [
  { id: "all", label: "Todos" },
  { id: "manager", label: "Gerentes" },
  { id: "waiter", label: "Garçons" },
  { id: "kitchen", label: "Cozinha" },
  { id: "cashier", label: "Caixas" },
  { id: "courier", label: "Entregadores" },
];

export default function UsersTab({ showToast }) {
  const [users, setUsers] = useState([]);
  const [filterRole, setFilterRole] = useState("all");
  const [newUserOpen, setNewUserOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [revealedPin, setRevealedPin] = useState(null);

  const load = useCallback(async () => {
    setUsers(await listUsers());
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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
  const tabs = ROLE_TABS.map((tab) => ({
    ...tab,
    count: tab.id === "all" ? users.length : users.filter((user) => user.role === tab.id).length,
  }));

  return (
    <TabbedWorkspace
      id="team"
      title="Equipe"
      description="Gerencie pessoas, perfis de acesso, fotos e PINs do estabelecimento."
      tabs={tabs}
      activeTab={filterRole}
      onTabChange={setFilterRole}
      actions={
        <button
          type="button"
          onClick={() => setNewUserOpen(true)}
          className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary-strong"
        >
          <Plus size={16} /> Novo usuário
        </button>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          {filteredUsers.map((u) => (
            <div
              key={u.id}
              className={`flex items-center justify-between gap-3 bg-surface border border-border rounded-xl px-4 py-3 ${!u.active ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <UserAvatar name={u.name} photoPath={u.photoPath} className="w-9 h-9 text-xs" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{u.name}</div>
                  <div className="text-text-muted text-xs">{ROLE_LABEL[u.role]}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => setEditing(u)}
                  title="Editar usuário"
                  aria-label={`Editar ${u.name}`}
                  className="text-text-muted hover:text-primary cursor-pointer"
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => handleResetPin(u)}
                  className="text-text-muted hover:text-primary cursor-pointer"
                  title="Redefinir PIN"
                  aria-label={`Redefinir PIN de ${u.name}`}
                >
                  <RefreshCcw size={15} />
                </button>
                <button
                  onClick={() => handleToggleActive(u)}
                  className="text-text-muted hover:text-primary cursor-pointer"
                  title={u.active ? "Desativar usuário" : "Ativar usuário"}
                  aria-label={u.active ? `Desativar ${u.name}` : `Ativar ${u.name}`}
                >
                  {u.active ? <UserX size={15} /> : <UserCheck size={15} />}
                </button>
              </div>
            </div>
          ))}
        </div>
        {filteredUsers.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border bg-surface/50 px-6 py-12 text-center">
            <p className="font-semibold">Nenhuma pessoa neste perfil</p>
            <p className="mt-1 text-sm text-text-muted">
              Escolha outra subaba ou cadastre alguém para a equipe.
            </p>
          </div>
        )}
      </div>

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
    </TabbedWorkspace>
  );
}

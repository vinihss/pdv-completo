import React, { useState, useCallback, useEffect } from "react";
import { Plus, RefreshCcw } from "lucide-react";
import { listUsers, createUser, updateUser, resetPin } from "@/entities/user";
import { Field, inputClass, ConfirmModal, Modal } from "@/shared/components";

const ROLE_LABEL = { waiter: "Garçom", kitchen: "Cozinha", manager: "Gerente", courier: "Entregador", cashier: "Caixa" };

export default function UsersTab({ showToast: _showToast }) {
  const [users, setUsers] = useState([]);
  const [newUserOpen, setNewUserOpen] = useState(false);
  const [revealedPin, setRevealedPin] = useState(null);

  const load = useCallback(async () => {
    setUsers(await listUsers());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleCreate(name, role) {
    const created = await createUser({ name, role });
    setRevealedPin({ name: created.name, pin: created.pin });
    setNewUserOpen(false);
    await load();
  }

  async function handleToggleActive(u) {
    await updateUser(u.id, { active: !u.active });
    await load();
  }

  async function handleResetPin(u) {
    const { pin } = await resetPin(u.id);
    setRevealedPin({ name: u.name, pin });
  }

  return (
    <div className="p-5 max-w-lg mx-auto space-y-4">
      <div className="space-y-2">
        {users.map((u) => (
          <div key={u.id} className={`flex items-center justify-between bg-stone-900 border border-stone-800 rounded-xl px-4 py-3 ${!u.active ? "opacity-50" : ""}`}>
            <div>
              <div className="text-sm font-semibold">{u.name}</div>
              <div className="text-stone-500 text-xs capitalize">{ROLE_LABEL[u.role]}</div>
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

export function NewUserModal({ onClose, onCreate }) {
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
    <Modal
      title="Novo usuário"
      onClose={onClose}
      footer={
        <button onClick={handleSubmit} disabled={saving} className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl">
          {saving ? "Criando…" : "Criar usuário"}
        </button>
      }
    >
      <div className="p-5">
        <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></Field>
        <div className="mt-3">
          <Field label="Perfil">
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>
              <option value="waiter">Garçom</option>
              <option value="kitchen">Cozinha</option>
              <option value="manager">Gerente</option>
              <option value="cashier">Caixa</option>
              <option value="courier">Entregador</option>
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}
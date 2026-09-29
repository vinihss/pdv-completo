import React, { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { createUser, updateUser, uploadUserPhoto, removeUserPhoto } from "@/entities/user";
import { Field, inputClass, Modal } from "@/shared/components";
import { maskPhone, initials } from "@/shared/lib";
import { assetUrl } from "@/shared/lib/server";

const ROLE_LABEL = { waiter: "Garçom", kitchen: "Cozinha", manager: "Gerente", cashier: "Caixa", courier: "Entregador" };
const ROLES = Object.keys(ROLE_LABEL);

function Avatar({ user, editable = false, onPick }) {
  const inputRef = useRef(null);
  return (
    <div className="relative shrink-0 self-start">
      {user?.photoPath ? (
        <img src={assetUrl(user.photoPath)} alt={user.name} className="w-16 h-16 rounded-full object-cover border border-stone-700" />
      ) : (
        <div className="w-16 h-16 rounded-full bg-stone-800 border border-stone-700 flex items-center justify-center text-stone-400 font-bold text-lg">
          {initials(user?.name ?? "?")}
        </div>
      )}
      {editable && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            aria-label="Enviar foto"
            className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-500 text-stone-950 flex items-center justify-center hover:bg-amber-400"
          >
            <Camera size={13} />
          </button>
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPick(e.target.files?.[0])} />
        </>
      )}
    </div>
  );
}

export default function UserModal({ user, onClose, onSaved, showToast }) {
  const isEdit = Boolean(user);
  const [name, setName] = useState(user?.name ?? "");
  const [role, setRole] = useState(user?.role ?? "waiter");
  const [phone, setPhone] = useState(user?.phone ? maskPhone(user.phone) : "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [pin, setPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handlePickPhoto(file) {
    if (!file) return;
    try {
      await uploadUserPhoto(user.id, file);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleRemovePhoto() {
    try {
      await removeUserPhoto(user.id);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Informe o nome do usuário.");
      return;
    }
    if (pin && !/^\d{4,6}$/.test(pin)) {
      setError("PIN deve ter de 4 a 6 dígitos.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const body = { name: name.trim(), role, phone: phone.trim() || null, email: email.trim() || null };
      if (pin) body.pin = pin;
      if (isEdit) await updateUser(user.id, body);
      else await createUser(body);
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={isEdit ? "Editar usuário" : "Novo usuário"}
      onClose={onClose}
      footer={
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl"
        >
          {saving ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar usuário"}
        </button>
      }
    >
      <div className="p-5 space-y-4">
        {isEdit && (
          <div className="flex items-center gap-4">
            <Avatar user={user} editable onPick={handlePickPhoto} />
            <div className="text-xs text-stone-500 space-y-1">
              <p>Foto do perfil — aparece no login.</p>
              {user?.photoPath && (
                <button type="button" onClick={handleRemovePhoto} className="flex items-center gap-1 text-red-400 hover:text-red-300">
                  <Trash2 size={12} /> Remover foto
                </button>
              )}
            </div>
          </div>
        )}

        <Field label="Nome" required>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setError(""); }}
            className={inputClass + (error && !name.trim() ? " border-red-500/60" : "")}
            autoFocus
          />
        </Field>

        <Field label="Perfil">
          <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </Field>

        <Field label="Telefone">
          <input
            value={phone}
            onChange={(e) => setPhone(maskPhone(e.target.value))}
            placeholder="(11) 99999-0000"
            inputMode="tel"
            className={inputClass}
          />
        </Field>

        <Field label="Email">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nome@exemplo.com"
            inputMode="email"
            className={inputClass}
          />
        </Field>

        <Field label={isEdit ? "Novo PIN (opcional — vazio mantém o atual)" : "PIN (opcional — vazio gera um automático)"}>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="4 a 6 dígitos"
            inputMode="numeric"
            className={inputClass}
          />
        </Field>

        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </Modal>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { createUser, updateUser, uploadUserPhoto, removeUserPhoto } from "@/entities/user";
import { Field, inputClass, Modal, UserAvatar } from "@/shared/components";
import { maskPhone } from "@/shared/lib";

const ROLE_LABEL = { waiter: "Garçom", kitchen: "Cozinha", manager: "Gerente", cashier: "Caixa", courier: "Entregador" };
const ROLES = Object.keys(ROLE_LABEL);

// Avatar do modal; o desenho da foto/iniciais é o UserAvatar de `shared`
// (mesma cara do login e do menu — nunca duplicar o círculo).
function PhotoBlock({ name, photoPath, editable, busy, onPick }) {
  const inputRef = useRef(null);
  return (
    <div className="relative shrink-0 self-start">
      <UserAvatar name={name} photoPath={photoPath} className="w-16 h-16 text-lg border border-stone-700" />
      {editable && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            aria-label="Enviar foto"
            title="Enviar foto"
            className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-500 text-stone-950 flex items-center justify-center hover:bg-amber-400 disabled:opacity-50"
          >
            <Camera size={13} />
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              onPick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
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

  // Foto no modo edição: espelho do photoPath do servidor. Upload/remove
  // respondem com a linha atualizada, e o avatar do modal tem que refletir
  // sem depender do `user` (snapshot) do pai — nem de reabrir o modal.
  const [photoPath, setPhotoPath] = useState(user?.photoPath ?? null);
  // Foto escolhida no modo criação (`{ file, preview }`): o POST /users/:id/photo
  // exige o id, então ela só sobe depois do createUser (ver handleSubmit).
  const [pendingPhoto, setPendingPhoto] = useState(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  // Preview local é um blob URL — revoga quando troca a foto e no unmount.
  useEffect(() => {
    return () => {
      if (pendingPhoto?.preview?.startsWith("blob:")) {
        URL.revokeObjectURL?.(pendingPhoto.preview);
      }
    };
  }, [pendingPhoto]);

  async function handlePickPhoto(file) {
    if (!file) return;
    if (isEdit) {
      // Edição: upload imediato no onChange (mesmo padrão do CustomerModal) —
      // o backend grava e devolve o photoPath novo. O modal fica aberto.
      setPhotoBusy(true);
      try {
        const updated = await uploadUserPhoto(user.id, file);
        setPhotoPath(updated.photoPath);
        await onSaved(); // recarrega a lista de usuários
      } catch (e) {
        showToast(e.message, "error");
      } finally {
        setPhotoBusy(false);
      }
    } else {
      // Criação: ainda não existe id — guarda o arquivo e a prévia local.
      setPendingPhoto({ file, preview: URL.createObjectURL(file) });
    }
  }

  async function handleRemovePhoto() {
    if (!isEdit) {
      URL.revokeObjectURL?.(pendingPhoto?.preview);
      setPendingPhoto(null);
      return;
    }
    setPhotoBusy(true);
    try {
      const updated = await removeUserPhoto(user.id);
      setPhotoPath(updated.photoPath);
      await onSaved();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Informe o nome do usuário.");
      return;
    }
    if (isEdit && pin && !/^\d{4,6}$/.test(pin)) {
      setError("PIN deve ter de 4 a 6 dígitos.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const body = { name: name.trim(), role, phone: phone.trim() || null, email: email.trim() || null };
      // Só a edição aceita PIN manual; a criação gera um PIN automático que
      // será revelado uma vez após o cadastro.
      if (isEdit && pin) body.pin = pin;

      let saved;
      if (isEdit) {
        saved = await updateUser(user.id, body);
      } else {
        saved = await createUser(body);
        // Decisão (foto no cadastro): `POST /users/:id/photo` exige o id, então
        // o upload acontece DEPOIS do createUser. Se o upload falhar, o usuário
        // JÁ existe — desfazer a criação faria o gerente perder o PIN revelado e
        // recriar do zero. Portanto: não desfazemos, avisamos que a foto não
        // subiu e ela fica para a edição; o cadastro em si é sucesso.
        if (pendingPhoto) {
          try {
            await uploadUserPhoto(saved.id, pendingPhoto.file);
          } catch (e) {
            showToast(`Usuário criado, mas a foto não subiu: ${e.message}. Envie a foto pela edição.`, "error");
          }
        }
      }

      await onSaved(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const showRemove = isEdit ? Boolean(photoPath) : Boolean(pendingPhoto);

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
        <div className="flex items-center gap-4">
          <PhotoBlock
            name={name}
            photoPath={isEdit ? photoPath : pendingPhoto?.preview}
            editable
            busy={photoBusy}
            onPick={handlePickPhoto}
          />
          <div className="text-xs text-stone-500 space-y-1">
            <p>Foto do perfil — aparece no login.</p>
            {!isEdit && pendingPhoto && (
              <p className="text-amber-400/90">Enviada junto com a criação — se falhar, você ajusta na edição.</p>
            )}
            {showRemove && (
              <button
                type="button"
                onClick={handleRemovePhoto}
                disabled={photoBusy}
                className="flex items-center gap-1 text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                <Trash2 size={12} /> {isEdit ? "Remover foto" : "Remover seleção"}
              </button>
            )}
          </div>
        </div>

        <Field label="Nome" required>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setError(""); }}
            className={inputClass + (error && !name.trim() ? " border-red-500/60" : "")}
            aria-invalid={Boolean(error && !name.trim())}
            aria-describedby={error && !name.trim() ? "user-modal-name-error" : undefined}
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

        {isEdit ? (
          <Field label="Novo PIN (opcional — vazio mantém o atual)">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="4 a 6 dígitos"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
        ) : (
          <p className="text-xs text-stone-500">Um PIN será gerado automaticamente e exibido uma única vez após criar o usuário.</p>
        )}

        {error && <p id={!name.trim() ? "user-modal-name-error" : undefined} className="text-red-400 text-xs" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

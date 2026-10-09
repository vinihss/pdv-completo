import React from "react";
import { Trash2 } from "lucide-react";
import { useAuth } from "@/app/providers/auth";
import { useNavigate } from "react-router-dom";
import { getMe, uploadUserMePhoto, removeUserMePhoto } from "@/entities/session";
import { Field, inputClass, ScreenHeader, UserAvatar, PhotoUpload } from "@/shared/components";

/**
 * Perfil do usuário logado (menu do header → Perfil).
 *
 * Edição limitada de propósito: nome, telefone e e-mail apenas — trocar papel
 * (role), PIN ou desativar conta é exclusivo da tela de Equipe do gerente
 * (`users/UserModal.jsx`), porque passa por `PATCH /users/:id` (manager).
 * Aqui vale `PATCH /auth/me` (self-service), que aceita só esses três campos.
 *
 * Os campos phone/email vêm do `GET /auth/me` no mount: o login só guarda
 * {id,name,role,photoPath} na sessão, e editar sobre um campo vazio apagaria
 * dado existente.
 *
 * Foto: `uploadUserMePhoto` (POST /auth/me/photo, multipart) e
 * `removeUserMePhoto` (DELETE /auth/me/photo). O backend trata campo omitido
 * como "não altera", então mesmo se o GET falhar nada é apagado às cegas.
 */
export default function ProfilePage() {
  const { session, updateProfile } = useAuth();
  const navigate = useNavigate();

  // Hooks sempre no topo — sem return antecipado antes deles.
  const [name, setName] = React.useState(session?.user?.name ?? "");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null); // { kind: "error" | "ok", text }

  // Último valor conhecido do servidor: phone/email só saem no PATCH se o
  // usuário mudou. Se o GET falhar (offline/rota nova), o campo intocado fica
  // de fora do payload e o dado existente não é apagado — o usecase do backend
  // trata campo omitido como "não altera".
  const loadedRef = React.useRef({ phone: "", email: "" });

  // Foto do usuário logado (pode ser vinda do servidor ou placeholder).
  const [photoPath, setPhotoPath] = React.useState(session?.user?.photoPath ?? null);
  const [photoBusy, setPhotoBusy] = React.useState(false);

  React.useEffect(() => {
    if (!session?.user) navigate("/login", { replace: true });
  }, [session?.user, navigate]);

  // Lê o perfil fresco: completa a sessão com o que o login não traz.
  React.useEffect(() => {
    let alive = true;
    getMe()
      .then((me) => {
        if (!alive || !me) return;
        loadedRef.current = { phone: me.phone ?? "", email: me.email ?? "" };
        setName(me.name ?? "");
        setPhone(me.phone ?? "");
        setEmail(me.email ?? "");
        // Foto: o login não traz phone/email mas traz photoPath.
        setPhotoPath(me.photoPath ?? null);
      })
      .catch(() => {
        // Sem leitura disponível: a tela segue com o que a sessão tem e o
        // save só envia campos alterados (acima) — nada é apagado às cegas.
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!session?.user) return null;

  async function handleSave(e) {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (!name.trim()) {
      setFeedback({ kind: "error", text: "Informe o nome." });
      return;
    }
    const payload = { name: name.trim() };
    if (phone.trim() !== loadedRef.current.phone) payload.phone = phone.trim();
    if (email.trim() !== loadedRef.current.email) payload.email = email.trim();

    setSaving(true);
    setFeedback(null);
    try {
      await updateProfile(payload);
      loadedRef.current = { phone: phone.trim(), email: email.trim() };
      setFeedback({ kind: "ok", text: "Perfil atualizado." });
    } catch (err) {
      setFeedback({ kind: "error", text: err?.message ?? "Não foi possível salvar." });
    } finally {
      setSaving(false);
    }
  }

  async function handlePickPhoto(file) {
    if (!file) return;
    setPhotoBusy(true);
    try {
      const updated = await uploadUserMePhoto(file);
      setPhotoPath(updated.photoPath ?? null);
      await handleSave(); // salva nome/phone/email se mudou
    } catch (err) {
      const msg = err?.message ?? "Não foi possível enviar a foto.";
      setFeedback({ kind: "error", text: msg });
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleRemovePhoto() {
    setPhotoBusy(true);
    try {
      await removeUserMePhoto();
      setPhotoPath(null);
      await handleSave(); // salva nome/phone/email se mudou
    } catch (err) {
      const msg = err?.message ?? "Não foi possível remover a foto.";
      setFeedback({ kind: "error", text: msg });
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <div className="bg-stone-950 min-h-screen">
      <ScreenHeader title="Meu perfil" subtitle="Nome, telefone e e-mail" onBack={() => navigate(-1)} />
      <div className="p-6 max-w-md mx-auto">
        <div className="text-center mb-6">
          <PhotoUpload
            name={session.user.name}
            photoPath={photoPath ?? session.user.photoPath}
            editable={true}
            busy={photoBusy}
            onPick={handlePickPhoto}
            onRemove={handleRemovePhoto}
            showRemove={Boolean(photoPath || session.user.photoPath)}
            className="w-24 h-24 mx-auto text-3xl"
          />
          <p className="text-stone-500 text-sm mt-2">
            Papel e PIN são definidos pelo gerente na tela de Equipe.
          </p>
        </div>

        <form id="profile-form" className="space-y-4" onSubmit={handleSave} noValidate>
          <Field label="Nome">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Seu nome completo"
              className={inputClass}
              disabled={loading || saving}
              autoFocus
            />
          </Field>

          <Field label="Telefone">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(11) 99999-0000"
              inputMode="tel"
              className={inputClass}
              disabled={loading || saving}
            />
          </Field>

          <Field label="Email">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              inputMode="email"
              className={inputClass}
              disabled={loading || saving}
            />
          </Field>

          {feedback && (
            <p
              role={feedback.kind === "error" ? "alert" : "status"}
              className={`text-sm ${feedback.kind === "error" ? "text-red-400" : "text-emerald-400"}`}
            >
              {feedback.text}
            </p>
          )}
        </form>
        {/* Botão fora do <form>, vinculado por form= (regra do repo). */}
        <button
          type="submit"
          form="profile-form"
          disabled={loading || saving}
          className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors mt-2"
        >
          {saving ? "Salvando…" : "Salvar alterações"}
        </button>
      </div>
    </div>
  );
}
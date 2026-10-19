import { useAuth } from "@/app/providers/auth";
import { forgotPassword, getDeviceTenantSlug } from "@/entities/session";
import { Button, Input } from "@/shared/components";
import { Loader2 } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ChangePasswordScreen from "./ChangePasswordScreen.jsx";
import CompanySelectScreen from "./CompanySelectScreen.jsx";
import ForgotPasswordScreen from "./ForgotPasswordScreen.jsx";
import LoginShell from "./LoginShell.jsx";
import PasswordInput from "./PasswordInput.jsx";

// Erro de login é GENÉRICO de propósito: não distinguir "senha errada" de
// "conta inexistente" (docs/26 §4 — o backend já responde 401 genérico e o
// frontend não pode vazar enumeração por outro caminho).
function loginErrorMessage(error) {
  if (error?.code === "too_many_attempts") return "Muitas tentativas. Aguarde um minuto e tente de novo.";
  if (!error?.status) return "Não foi possível conectar ao servidor. Tente novamente.";
  return "E-mail ou senha incorretos.";
}

function changePasswordErrorMessage(error) {
  if (error?.status === 401) return "Sua sessão expirou. Entre novamente para trocar a senha.";
  if (!error?.status) return "Não foi possível conectar ao servidor. Tente novamente.";
  return error?.message || "Não foi possível salvar a nova senha. Tente novamente.";
}

/**
 * Login da identidade centralizada (docs/26 §5): e-mail + senha → troca de
 * senha obrigatória (quando vier temporária) → seleção de empresa (só se houver
 * mais de uma) → sessão. Sem lista de usuários e sem escolha de papel: o papel
 * vem do vínculo da conta com a empresa escolhida.
 */
export default function LoginPage() {
  const { loginNovo, changeAccountPassword, completeTenantSelection, cancelAccountStage } =
    useAuth();
  const [searchParams] = useSearchParams();
  // /login?forgot=1 é o destino do link "esqueci de novo" vindo da tela de reset.
  const [stage, setStage] = useState(() => (searchParams.get("forgot") ? "forgot" : "credentials"));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [forgotSent, setForgotSent] = useState(false);

  // Docs/26 §5: 1 empresa → direto; N com preferência do dispositivo → direto;
  // N sem preferência → seletor; nenhum vínculo → aviso. A preferência é só
  // atalho: o backend revalida o vínculo em select-tenant.
  const resolveCompanies = useCallback(
    async (lista) => {
      if (!lista.length) {
        setStage("none");
        return;
      }
      if (lista.length === 1) {
        await completeTenantSelection(lista[0].slug);
        return;
      }
      const preferred = getDeviceTenantSlug();
      const saved = preferred ? lista.find((c) => c.slug === preferred) : null;
      if (saved) {
        await completeTenantSelection(saved.slug);
        return;
      }
      setCompanies(lista);
      setStage("company");
    },
    [completeTenantSelection]
  );

  const handleCredentialsSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const email = String(data.get("email") ?? "").trim();
      const password = String(data.get("password") ?? "");
      const remember = Boolean(data.get("remember"));
      if (!email || !password) {
        setError("Informe e-mail e senha para continuar.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await loginNovo(email, password, remember);
        if (result.mustChangePassword) {
          setStage("change");
          return;
        }
        await resolveCompanies(result.companies);
      } catch (e) {
        setError(loginErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [loginNovo, resolveCompanies]
  );

  const handleChangePasswordSubmit = useCallback(
    async (nova, confirmacao) => {
      if (!nova || !confirmacao) {
        setError("Preencha e confirme a nova senha.");
        return;
      }
      if (nova !== confirmacao) {
        setError("As senhas não coincidem. Digite a mesma senha nos dois campos.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await changeAccountPassword(nova);
        await resolveCompanies(next.companies);
      } catch (e) {
        setError(changePasswordErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [changeAccountPassword, resolveCompanies]
  );

  const handleSelectCompany = useCallback(
    async (slug) => {
      setLoading(true);
      setError(null);
      try {
        await completeTenantSelection(slug);
      } catch (e) {
        // 403 = vínculo recusado pelo backend (ex.: removido da loja entre o
        // login e a escolha); 401 = accountToken de 10min venceu no seletor.
        setError(
          e?.code === "tenant_not_linked"
            ? "Você não tem mais acesso a esta empresa. Fale com o gerente."
            : e?.status === 401
              ? "Sua sessão expirou. Entre novamente."
              : "Não foi possível entrar agora. Tente novamente."
        );
      } finally {
        setLoading(false);
      }
    },
    [completeTenantSelection]
  );

  const handleForgotSubmit = useCallback(async (email) => {
    if (!email) {
      setError("Informe o e-mail da sua conta.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await forgotPassword(email);
      setForgotSent(true);
    } catch (e) {
      setError(
        e?.code === "email_not_configured" || e?.status === 503
          ? "A recuperação de senha por e-mail ainda não está configurada nesta loja. Procure o gerente da sua equipe."
          : "Não foi possível enviar agora. Aguarde alguns minutos e tente de novo."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const backToCredentials = useCallback(() => {
    cancelAccountStage();
    setError(null);
    setForgotSent(false);
    setStage("credentials");
  }, [cancelAccountStage]);

  if (stage === "change") {
    return (
      <LoginShell
        title="Crie sua senha"
        subtitle="Você está entrando com a senha temporária enviada por e-mail. Defina uma senha própria para continuar."
      >
        <ChangePasswordScreen
          onSubmit={handleChangePasswordSubmit}
          loading={loading}
          error={error}
        />
      </LoginShell>
    );
  }

  if (stage === "company") {
    return (
      <LoginShell
        title="Escolha a empresa"
        subtitle={`Você está vinculado a ${companies.length} empresas. Qual é a do seu turno de hoje?`}
      >
        <CompanySelectScreen
          companies={companies}
          onSelect={handleSelectCompany}
          loading={loading}
          error={error}
          onBack={backToCredentials}
        />
      </LoginShell>
    );
  }

  if (stage === "none") {
    return (
      <LoginShell
        title="Sem empresa vinculada"
        subtitle="Sua conta ainda não foi adicionada a nenhuma loja."
      >
        <div className="flex flex-col gap-5 text-center">
          <p role="alert" className="text-sm text-destructive text-pretty">
            Nenhuma empresa vinculada a esta conta. Contate o gerente.
          </p>
          <Button type="button" variant="secondary" onClick={backToCredentials} className="w-full">
            Entrar com outra conta
          </Button>
        </div>
      </LoginShell>
    );
  }

  if (stage === "forgot") {
    return (
      <LoginShell
        title="Recuperar senha"
        subtitle="Enviaremos as instruções de recuperação para o e-mail da sua conta."
      >
        <ForgotPasswordScreen
          onSubmit={handleForgotSubmit}
          loading={loading}
          error={error}
          sent={forgotSent}
          onBack={backToCredentials}
        />
      </LoginShell>
    );
  }

  return (
    <LoginShell
      title="Bem-vindo de volta"
      subtitle="Entre com sua conta para começar o turno."
    >
      <form onSubmit={handleCredentialsSubmit} className="flex flex-col gap-5" noValidate aria-busy={loading}>
        <div>
          <label htmlFor="login-email" className="text-text-secondary text-sm font-medium mb-1.5 block">
            E-mail
          </label>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="voce@restaurante.com.br"
            disabled={loading}
            className="h-11"
          />
        </div>

        <div>
          <label
            htmlFor="login-password"
            className="text-text-secondary text-sm font-medium mb-1.5 block"
          >
            Senha
          </label>
          <PasswordInput
            id="login-password"
            name="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            disabled={loading}
            className="h-11"
          />
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2 text-text-secondary">
            <input
              type="checkbox"
              name="remember"
              defaultChecked
              disabled={loading}
              className="size-4 rounded accent-primary"
            />
            Lembrar de mim
          </label>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStage("forgot");
            }}
            disabled={loading}
            className="font-medium text-primary-strong underline-offset-4 hover:underline disabled:opacity-50"
          >
            Esqueci a senha
          </button>
        </div>

        <Button type="submit" size="lg" disabled={loading} className="w-full">
          {loading ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Entrando…
            </>
          ) : (
            "Entrar"
          )}
        </Button>
      </form>
    </LoginShell>
  );
}

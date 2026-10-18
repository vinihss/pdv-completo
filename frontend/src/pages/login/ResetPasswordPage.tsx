import { resetPassword } from "@/entities/session";
import { Button } from "@/shared/components";
import { KeyRound, Loader2 } from "lucide-react";
import React, { useCallback, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import LoginShell from "./LoginShell.jsx";
import PasswordInput from "./PasswordInput.jsx";

const INVALID_TOKEN_MSG =
  "Este link de recuperação é inválido ou já expirou. Solicite um novo abaixo — ele vale por alguns minutos.";

/**
 * /reset-password?token=… — página PÚBLICA (chegou pelo link do e-mail de
 * recuperação, docs/26 §4). Não tem sessão nem etapa de conta: o token do link
 * é a autorização. Sucesso → aviso para logar; token inválido/expirado/usado
 * (400) → mensagem + link para pedir de novo.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(token ? null : INVALID_TOKEN_MSG);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const nova = String(data.get("newPassword") ?? "");
      const confirmacao = String(data.get("confirmPassword") ?? "");
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
        await resetPassword(token, nova);
        setDone(true);
      } catch (e) {
        setError(e?.status === 400 ? INVALID_TOKEN_MSG : "Não foi possível salvar agora. Tente novamente.");
      } finally {
        setLoading(false);
      }
    },
    [token]
  );

  if (done) {
    return (
      <LoginShell title="Senha redefinida" subtitle="Tudo certo — sua nova senha já está ativa.">
        <div className="flex flex-col gap-5 text-center">
          <div className="mx-auto rounded-full bg-success/10 p-3">
            <KeyRound size={28} className="text-success" aria-hidden="true" />
          </div>
          <p className="text-sm text-text-secondary">
            Entre com o e-mail e a senha novos para acessar suas empresas.
          </p>
          <Button
            type="button"
            className="w-full"
            onClick={() => navigate("/login", { replace: true })}
          >
            Ir para o login
          </Button>
        </div>
      </LoginShell>
    );
  }

  return (
    <LoginShell
      title="Crie sua nova senha"
      subtitle="Defina uma senha definitiva para a sua conta."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate aria-busy={loading}>
        <div>
          <label
            htmlFor="reset-password"
            className="text-text-secondary text-sm font-medium mb-1.5 block"
          >
            Nova senha
          </label>
          <PasswordInput
            id="reset-password"
            name="newPassword"
            autoComplete="new-password"
            required
            placeholder="••••••••"
            disabled={loading || !token}
            className="h-11"
          />
        </div>

        <div>
          <label
            htmlFor="reset-confirm-password"
            className="text-text-secondary text-sm font-medium mb-1.5 block"
          >
            Confirmar nova senha
          </label>
          <PasswordInput
            id="reset-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            required
            placeholder="••••••••"
            disabled={loading || !token}
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

        <Button type="submit" size="lg" disabled={loading || !token} className="w-full">
          {loading ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Salvando…
            </>
          ) : (
            "Salvar nova senha"
          )}
        </Button>

        {/* Link "esqueci de novo": volta para o login já na tela de recuperação. */}
        <Link
          to="/login?forgot=1"
          className="text-sm font-medium text-text-secondary hover:text-foreground underline-offset-4 hover:underline text-center"
        >
          Não tem mais este link? Solicite uma nova recuperação
        </Link>
      </form>
    </LoginShell>
  );
}

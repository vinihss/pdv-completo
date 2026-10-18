import { Button } from "@/shared/components";
import { Loader2 } from "lucide-react";
import React from "react";
import PasswordInput from "./PasswordInput.jsx";

/**
 * Troca de senha OBRIGATÓRIA do primeiro login (docs/26 §2, decisão 8): a
 * senha temporária que veio por e-mail não pode continuar. Bloqueia a seleção
 * de empresa até concluir — não tem "pular" nem volta.
 */
export default function ChangePasswordScreen({ onSubmit, loading, error }) {
  function handleSubmit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nova = String(data.get("newPassword") ?? "");
    const confirmacao = String(data.get("confirmPassword") ?? "");
    onSubmit(nova, confirmacao);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate aria-busy={loading}>
      <div>
        <label htmlFor="new-password" className="text-text-secondary text-sm font-medium mb-1.5 block">
          Nova senha
        </label>
        <PasswordInput
          id="new-password"
          name="newPassword"
          autoComplete="new-password"
          required
          placeholder="••••••••"
          disabled={loading}
          className="h-11"
        />
      </div>

      <div>
        <label
          htmlFor="confirm-password"
          className="text-text-secondary text-sm font-medium mb-1.5 block"
        >
          Confirmar nova senha
        </label>
        <PasswordInput
          id="confirm-password"
          name="confirmPassword"
          autoComplete="new-password"
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

      <Button type="submit" size="lg" disabled={loading} className="w-full">
        {loading ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            Salvando…
          </>
        ) : (
          "Salvar nova senha"
        )}
      </Button>
    </form>
  );
}

import { Button, Input } from "@/shared/components";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";
import React from "react";

/**
 * "Esqueci a senha": pede o e-mail e sempre responde com a MESMA confirmação,
 * seja a conta existente ou não (o backend responde 202 sem enumeração,
 * docs/26 §4). Sem SMTP configurado o backend devolve 503 — aí sim mostramos
 * um aviso honesto, sem sugerir que a conta existe ou não.
 */
export default function ForgotPasswordScreen({ onSubmit, loading, error, sent, onBack }) {
  function handleSubmit(event) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    onSubmit(email);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-5 text-center">
        <div className="mx-auto rounded-full bg-success/10 p-3">
          <MailCheck size={28} className="text-success" aria-hidden="true" />
        </div>
        <p className="text-sm text-text-secondary text-pretty">
          Se houver uma conta com este e-mail, você receberá as instruções de recuperação em
          alguns minutos. Não esqueça de conferir a caixa de spam.
        </p>
        <Button type="button" variant="secondary" onClick={onBack} className="w-full">
          <ArrowLeft size={16} aria-hidden="true" />
          Voltar para o login
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate aria-busy={loading}>
      <div>
        <label htmlFor="forgot-email" className="text-text-secondary text-sm font-medium mb-1.5 block">
          E-mail da conta
        </label>
        <Input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="voce@restaurante.com.br"
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
            Enviando…
          </>
        ) : (
          "Enviar instruções"
        )}
      </Button>

      <button
        type="button"
        onClick={onBack}
        disabled={loading}
        className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-text-secondary hover:text-foreground underline-offset-4 hover:underline disabled:opacity-50"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Voltar para o login
      </button>
    </form>
  );
}

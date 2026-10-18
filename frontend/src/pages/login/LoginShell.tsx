import { ThemeToggle } from "@/shared/components";
import { Lock } from "lucide-react";
import React from "react";

/**
 * Casca das telas de identidade (login, troca de senha, seleção de empresa,
 * forgot/reset). Layout adaptado da referência visual do projeto Cheempa:
 * painel de marca à esquerda (lg+) e formulário à direita — mas com os tokens
 * deste app (sidebar marrom, dourado como acento) e sem cards de perfil: o
 * papel vem do vínculo da conta com a empresa, não de uma escolha no login.
 */
export default function LoginShell({ title, subtitle, children }) {
  return (
    <div className="relative min-h-dvh bg-background text-foreground grid lg:grid-cols-2">
      {/* Painel de marca (desktop): identidade do PRODUTO. A identidade da
          loja só aparece depois, na seleção de empresa — aqui ainda não há
          sessão nem tenant. */}
      <aside className="hidden lg:flex flex-col justify-between bg-sidebar text-sidebar-foreground p-10 relative overflow-hidden">
        <div className="flex items-center gap-3 relative z-10">
          <div className="h-11 w-11 rounded-2xl bg-sidebar-primary flex items-center justify-center shrink-0">
            <Lock size={22} className="text-sidebar-primary-foreground" strokeWidth={2.5} />
          </div>
          <div>
            <p className="font-display text-2xl font-semibold leading-none">PDV Restaurante</p>
            <p className="text-sm text-sidebar-foreground/70 mt-1">
              Comandas, cozinha e entregas em tempo real
            </p>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <h2 className="text-4xl leading-tight font-semibold text-balance">
            Do salão ao delivery,{" "}
            <span className="text-sidebar-primary">tudo no mesmo ritmo</span>.
          </h2>
          <p className="mt-4 text-sidebar-foreground/75 text-pretty">
            Uma conta para todas as suas lojas: entre com e-mail e senha e escolha a empresa do
            seu turno.
          </p>
        </div>

        <p className="text-sm text-sidebar-foreground/60 relative z-10">
          Seu gerente convida você por e-mail — a senha é trocada no primeiro acesso.
        </p>

        {/* Forma decorativa de fundo (marrom mais escuro); fora do fluxo de leitura. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full bg-sidebar-accent opacity-70"
        />
      </aside>

      <main className="flex flex-col items-center justify-center px-5 py-10">
        <ThemeToggle className="absolute right-4 top-4" />
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center lg:text-left">
            <div className="mb-4 inline-flex items-center justify-center rounded-full bg-primary/20 p-2.5 lg:hidden">
              <Lock size={22} className="text-primary-strong" />
            </div>
            <h1 className="font-display text-3xl font-semibold">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-text-muted text-pretty">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

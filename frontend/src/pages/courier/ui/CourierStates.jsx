import React from "react";
import { PackageCheck, RefreshCcw, WifiOff } from "lucide-react";

/**
 * Estados obrigatórios da tela: carregando, erro com retry e os DOIS vazios.
 *
 * Os dois vazios são textos diferentes porque significam coisas diferentes: um
 * entregador sem nada para fazer é bom dia; um entregador com uma entrega em
 * rota e nada na fila ainda está trabalhando, e dizer "tudo em dia" para quem
 * tem pedido na mão é mentira.
 */
export function CourierSkeleton() {
  return (
    <div className="space-y-4" data-testid="courier-skeleton" aria-hidden="true">
      {/* Hero: bloco maior, para não "pular" quando o card real entrar. */}
      <div className="rounded-2xl border border-stone-800 bg-stone-900 p-4 space-y-3 animate-pulse">
        <div className="flex items-center justify-between gap-3">
          <div className="h-5 w-40 rounded bg-stone-800" />
          <div className="h-5 w-20 rounded-full bg-stone-800" />
        </div>
        <div className="h-4 w-full rounded bg-stone-800" />
        <div className="h-4 w-2/3 rounded bg-stone-800" />
        <div className="h-14 w-full rounded-xl bg-stone-800" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="rounded-2xl border border-stone-800 bg-stone-900 p-3.5 space-y-2.5 animate-pulse">
          <div className="h-4 w-1/2 rounded bg-stone-800" />
          <div className="h-3.5 w-full rounded bg-stone-800" />
          <div className="h-12 w-full rounded-xl bg-stone-800" />
        </div>
      ))}
    </div>
  );
}

export function CourierError({ onRetry, busy }) {
  return (
    <div className="py-14 text-center" role="alert">
      <RefreshCcw size={26} className="mx-auto text-stone-700 mb-3" />
      <p className="text-sm font-semibold text-stone-300">Não consegui carregar suas entregas</p>
      <p className="text-xs text-stone-500 mt-1">Verifique o sinal e tente de novo.</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="mt-4 h-11 px-4 rounded-xl border border-stone-700 text-stone-200 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-40"
      >
        <RefreshCcw size={15} />
        Tentar de novo
      </button>
    </div>
  );
}

/** Recarga falhou mas há lista na tela: mostra o que dá e avisa o resto. */
export function StaleWarning({ onRetry }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
      <RefreshCcw size={14} className="text-amber-400 shrink-0" />
      <p className="text-xs text-amber-200 flex-1">Não consegui atualizar a lista.</p>
      <button type="button" onClick={onRetry} aria-label="Atualizar entregas" className="text-xs font-bold text-amber-300 underline underline-offset-2 inline-flex items-center gap-1.5">
        <RefreshCcw size={13} />
      </button>
    </div>
  );
}

/** Sem rede nenhuma: a lista da tela é a última conhecida. */
export function OfflineBanner() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-stone-700 bg-stone-900 px-3 py-2.5">
      <WifiOff size={14} className="text-stone-400 shrink-0" />
      <p className="text-xs text-stone-300">Sem conexão — o app atualiza sozinho quando o sinal voltar.</p>
    </div>
  );
}

/** Tela inteira vazia: nada em rota, nada na fila, nenhum problema aberto. */
export function CourierEmpty() {
  return (
    <div className="py-16 text-center">
      <PackageCheck size={32} className="mx-auto text-emerald-600/70 mb-3" />
      <p className="text-base font-display font-bold text-stone-200">Tudo em dia por aqui</p>
      <p className="text-xs text-stone-500 mt-1">Nenhuma entrega na fila e nada em rota.</p>
    </div>
  );
}

/** Só a fila vazia — há trabalho em rota (ou um problema aberto). */
export function QueueEmpty() {
  return (
    <div className="rounded-2xl border border-stone-800 border-dashed p-5 text-center">
      <p className="text-sm font-semibold text-stone-400">Nada na fila</p>
      <p className="text-xs text-stone-500 mt-1">O próximo pedido aparece aqui.</p>
    </div>
  );
}
import React, { useState } from "react";
import { useAppConfig, AppConfigFields } from "@/app/providers/app-config";

/**
 * Configuração do primeiro boot. Aparece quando não há app.json — o
 * instalador não conseguiu perguntar (instalação em outro idioma, config
 * apagada) ou é a primeira vez que o app é aberto na máquina.
 *
 * É a tela que destrava a Fase 1: sem endereço de sistema o app nem
 * consegue falar com a API, então ela vem antes de qualquer outra coisa.
 */
export default function SetupForm() {
  const { save, saving, error } = useAppConfig();
  const [draft, setDraft] = useState({ mode: "local", apiBase: "", daemonUrl: "" });
  const [touched, setTouched] = useState(false);

  const address = draft.apiBase?.trim() ?? "";
  const invalid = touched && !address;

  async function handleSubmit(e) {
    e.preventDefault();
    setTouched(true);
    if (!address) return;
    try {
      await save(draft);
    } catch {
      // erro fica no contexto e é mostrado abaixo
    }
  }

  return (
    <div className="min-h-screen bg-stone-950 flex items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500 text-lg font-black text-stone-950">
            PDV
          </div>
          <h1 className="text-base font-semibold text-stone-100">Configurar este computador</h1>
          <p className="text-sm text-stone-500">
            Uma vez só. O endereço pode ser corrigido depois, em Configurações.
          </p>
        </div>

        <div className="space-y-4 rounded-2xl bg-stone-900/60 border border-stone-800 p-4">
          <AppConfigFields value={draft} onChange={setDraft} />
          {invalid && <p className="text-xs text-red-400">Informe o endereço do sistema.</p>}
          {error && <p className="text-xs text-red-400">{error.message}</p>}
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors"
        >
          {saving ? "Salvando…" : "Salvar e abrir"}
        </button>
      </form>
    </div>
  );
}

import React from "react";
import { Field, inputClass } from "@/shared/components";

/**
 * Campos de configuração do aplicativo (modo local × cloud). Vive em `app/`
 * porque é usado em dois lugares: a tela de setup do primeiro boot e a aba
 * de Configurações do gerente — corrigir a URL não pode exigir reinstalar.
 *
 * Puramente apresentacional: quem decide o que salvar é o chamador.
 */
export default function AppConfigFields({ value, onChange, showDaemon = true }) {
  const config = value ?? { mode: "local", apiBase: "", daemonUrl: "" };
  const set = (patch) => onChange?.({ ...config, ...patch });
  const isLocal = config.mode !== "cloud";

  return (
    <>
      <Field label="Onde o sistema (API) está instalado?">
        <div className="grid grid-cols-2 gap-2">
          {[
            { id: "local", label: "Nesta máquina" },
            { id: "cloud", label: "Servidor / nuvem" },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => set({ mode: opt.id })}
              className={`py-2.5 rounded-xl text-sm font-semibold border ${
                config.mode === opt.id
                  ? "bg-amber-500 text-stone-950 border-amber-500"
                  : "bg-stone-900 border-stone-800 text-stone-400"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Endereço do sistema">
        <input
          value={config.apiBase ?? ""}
          onChange={(e) => set({ apiBase: e.target.value })}
          placeholder={isLocal ? "http://127.0.0.1:3000" : "https://app.seudominio.com.br"}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={inputClass}
        />
        <p className="text-stone-600 text-xs mt-1.5">
          {isLocal
            ? "Plano local: o sistema roda nesta mesma máquina (127.0.0.1:3000) e o app funciona sem internet."
            : "Plano nuvem: o sistema está em outro servidor. Sem internet, o app avisa que não conseguiu abrir."}
        </p>
      </Field>

      {showDaemon && (
        <Field label="Impressora local (daemon)">
          <input
            value={config.daemonUrl ?? ""}
            onChange={(e) => set({ daemonUrl: e.target.value })}
            placeholder="http://127.0.0.1:8080"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
          <p className="text-stone-600 text-xs mt-1.5">
            Serviço de impressão que roda nesta máquina. Só muda se o estabelecimento usa porta diferente.
          </p>
        </Field>
      )}
    </>
  );
}

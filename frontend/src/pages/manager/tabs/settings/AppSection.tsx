import { AppConfigFields, useAppConfig } from "@/app/providers/app-config";
import { Section } from "@/shared/components";
import { getVersion } from "@tauri-apps/api/app";
import { Monitor, RotateCcw } from "lucide-react";
import React, { useState, useEffect } from "react";

/**
 * Configuração do aplicativo (aba Configurações do gerente). Só aparece no
 * app desktop — no web não existe arquivo de config, a API é sempre a mesma
 * origem que serve a página.
 *
 * Grava em %APPDATA%\PDV\app.json, que fica FORA do diretório de
 * instalação: é o que permite corrigir a URL do cliente sem reinstalar e
 * sobreviver a cada auto-update.
 */
export default function AppSection({ showToast }) {
  const { config, save, restoreDefault, saving } = useAppConfig();
  const [draft, setDraft] = useState(config);
  const [version, setVersion] = useState("");

  useEffect(() => setDraft(config), [config]);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  if (!config) return null; // web, ou ainda não configurado (a tela de setup cobre)

  async function handleSave() {
    try {
      await save(draft);
      showToast("Configuração do aplicativo salva. Reabra o aplicativo para aplicar.", "success");
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function handleRestore() {
    try {
      await restoreDefault();
      showToast("Configuração restaurada para o padrão da instalação.", "success");
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  return (
    <Section title="Aplicativo">
      <div className="flex items-center gap-2 text-text-muted text-xs mb-3">
        <Monitor size={14} />
        <span>
          Versão {version || "—"} · plano {config.mode === "cloud" ? "nuvem" : "local"}
        </span>
      </div>

      <AppConfigFields value={draft} onChange={setDraft} />

      <div className="flex gap-2 mt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 bg-primary hover:bg-primary-strong disabled:opacity-50 text-primary-foreground font-semibold py-3 rounded-xl transition-colors"
        >
          {saving ? "Salvando…" : "Salvar aplicativo"}
        </button>
        <button
          onClick={handleRestore}
          disabled={saving}
          title="Voltar ao endereço definido na instalação"
          className="flex items-center gap-1.5 bg-surface-overlay hover:bg-surface-overlay border border-border rounded-xl px-3 text-xs font-semibold text-text-secondary disabled:opacity-50"
        >
          <RotateCcw size={13} /> Padrão
        </button>
      </div>

      <p className="text-text-muted text-xs mt-2">
        O endereço fica gravado por usuário ({`%APPDATA%`}\PDV\app.json). "Padrão" volta para o que
        o instalador definiu.
      </p>
    </Section>
  );
}

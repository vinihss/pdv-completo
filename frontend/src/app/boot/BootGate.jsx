import React, { useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { isDesktop } from "@/shared/lib";
import { useAppConfig } from "@/app/providers/app-config";
import { relaunch } from "@/entities/updater";
import { BOOT_PHASE, runBootSequence } from "./bootSequence.js";
import BootSplash from "./BootSplash.jsx";
import BootScreen from "./BootScreen.jsx";
import SetupForm from "./SetupForm.jsx";

// ============================================================
// Portão de boot.
//
// No web (PWA servido pelo Caddy) ele é transparente: `isDesktop()` false
// devolve os filhos e nada do que existe aqui é executado. Todo o custo é do
// app desktop, que é quem tem instalador, config em arquivo e update.
//
// No desktop a ordem é: config → sequência (update → health check) → app.
// A regra de "falha de update não bloqueia" e os timeouts vivem em
// bootSequence.js; aqui é só a tradução estado → tela.
// ============================================================

const OFFLINE_COPY = {
  cloud: {
    title: "Sem conexão com o sistema",
    message: "Não foi possível falar com o servidor do PDV.",
    hint: "Verifique a internet desta máquina e o endereço configurado.",
  },
  local: {
    title: "O sistema local não está rodando",
    message: "O endereço configurado para o PDV não respondeu.",
    hint: "Confira se o sistema está no ar (Docker ou serviço) e se a porta é a mesma.",
  },
};

export function BootGate({ children }) {
  const { config, loading } = useAppConfig();
  const [status, setStatus] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const desktop = isDesktop();
  const needsSetup = desktop && !loading && !config?.apiBase;

  useEffect(() => {
    if (!desktop || loading) return;
    // Sem endereço configurado não há sequência: o SetupForm salva e a
    // mudança em `config` dispara este efeito de novo.
    if (!config?.apiBase) {
      setStatus(null);
      return;
    }
    let alive = true;
    const onPhase = (next) => {
      if (alive) setStatus(next);
    };
    setStatus({ phase: BOOT_PHASE.CONNECTING });
    runBootSequence({ mode: config.mode, onPhase }).catch(() => {
      // As dependências já absorvem erro uma a uma; se algo escapar daqui o
      // certo é a tela de bloqueio com "Tentar de novo", não uma tela branca.
      if (alive) setStatus({ phase: BOOT_PHASE.OFFLINE, reason: config.mode });
    });
    return () => {
      alive = false;
    };
  }, [desktop, loading, config, attempt]);

  function retry() {
    // Troca o estado na mesma hora para não piscar a tela de erro de novo.
    setStatus({ phase: BOOT_PHASE.CONNECTING });
    setAttempt((n) => n + 1);
  }

  if (!desktop) return children;
  if (loading) return <BootSplash title="Abrindo o PDV…" />;
  if (needsSetup) return <SetupForm />;

  const phase = status?.phase;

  if (phase === BOOT_PHASE.READY) return children;

  if (phase === BOOT_PHASE.OFFLINE) {
    const copy = OFFLINE_COPY[status.reason] ?? OFFLINE_COPY.cloud;
    return <BootScreen {...copy} address={config.apiBase} onRetry={retry} />;
  }

  if (phase === BOOT_PHASE.UPDATING) {
    return (
      <BootSplash
        title="Atualizando o aplicativo"
        detail={status.version ? `Nova versão ${status.version}` : undefined}
        percent={status.percent}
      />
    );
  }

  if (phase === BOOT_PHASE.RESTARTING) {
    // No Windows o instalador fecha este processo durante a troca, então o
    // relaunch pode não ter alcançado a hora de rodar: o botão cobre isso.
    return (
      <BootSplash
        title="Atualização concluída"
        detail="Abrindo o PDV novamente…"
        action={
          <button
            onClick={() => relaunch()}
            className="w-full flex items-center justify-center gap-2 bg-stone-800 hover:bg-stone-750 border border-stone-700 text-stone-200 font-semibold py-3 rounded-xl transition-colors"
          >
            <RefreshCcw size={15} /> Abrir novamente
          </button>
        }
      />
    );
  }

  if (phase === BOOT_PHASE.FAILED_UPDATE) {
    return (
      <BootSplash
        title="Abrindo a versão atual"
        note="Não foi possível atualizar agora. O PDV abre normalmente."
      />
    );
  }

  if (phase === BOOT_PHASE.CHECKING) {
    return <BootSplash title="Verificando atualizações…" />;
  }

  return <BootSplash title="Conectando ao sistema…" address={config.apiBase} />;
}

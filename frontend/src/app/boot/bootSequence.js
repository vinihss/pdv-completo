import { pingApi } from "@/shared/api/http.js";
import { checkForUpdate, installUpdate, relaunch } from "@/entities/updater";

// ============================================================
// Sequência de boot do app desktop, separada do React.
//
// Fica num arquivo só, com as dependências injetadas, porque é a parte que
// tem regra de negócio: ordem das checagens, o que é bloqueante e o que
// não é. Testar isso sem DOM é o que garante que o restaurante não fica
// preso numa tela de espera.
//
// As três garantias:
//   1. web nunca entra aqui (o BootGate filtra antes);
//   2. update que falha NUNCA bloqueia — o app abre na versão atual;
//   3. quem decide se o sistema está no ar é o health check, não o updater.
// ============================================================

export const BOOT_PHASE = {
  CONNECTING: "connecting",
  CHECKING: "checking",
  UPDATING: "updating",
  FAILED_UPDATE: "failed_update",
  RESTARTING: "restarting",
  READY: "ready",
  OFFLINE: "offline",
};

export const API_PROBE_TIMEOUT_MS = 5000;

export const BOOT_OUTCOME = {
  READY: "ready",
  OFFLINE: "offline",
  RESTARTING: "restarting",
};

export const defaultDeps = { pingApi, checkForUpdate, installUpdate, relaunch };

/**
 * Rede de proteção das garantias acima. As dependências já absorvem o erro
 * delas mesmas, mas se uma delas lançar, a consequência não pode ser a tela
 * de "sem internet" — seria mentira. Aqui qualquer exceção vira o fallback e o
 * app abre na versão que está no disco.
 */
async function bestEffort(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * @param mode "local" | "cloud" — o plano de instalação.
 * @param onPhase callback com o estado da tela (splash).
 * @param deps injetável para teste.
 * @returns { outcome, reason? }
 */
export async function runBootSequence({ mode, onPhase, deps = defaultDeps }) {
  const isCloud = mode === "cloud";

  // Na nuvem o health check vem PRIMEIRO: o app não abre sem a API, e o
  // manifesto de update mora no mesmo servidor — então dá para avisar
  // "sem internet" já no primeiro segundo, sem esperar o timeout do updater.
  if (isCloud) {
    onPhase({ phase: BOOT_PHASE.CONNECTING });
    if (!(await deps.pingApi(API_PROBE_TIMEOUT_MS))) {
      onPhase({ phase: BOOT_PHASE.OFFLINE, reason: "cloud" });
      return { outcome: BOOT_OUTCOME.OFFLINE, reason: "cloud" };
    }
  }

  // Update: melhor esforço nos dois planos. Instalação local sem internet
  // gasta o timeout do manifesto (3s) e segue — o app desktop é justamente
  // o que precisa funcionar offline.
  onPhase({ phase: BOOT_PHASE.CHECKING });
  const found = await bestEffort(() => deps.checkForUpdate(), { available: false });
  if (found.available) {
    const updatePhase = { version: found.version, notes: found.notes, percent: 0 };
    onPhase({ phase: BOOT_PHASE.UPDATING, ...updatePhase });
    const result = await bestEffort(
      () => deps.installUpdate(found.update, (progress) => onPhase({ phase: BOOT_PHASE.UPDATING, ...updatePhase, ...progress })),
      { ok: false, reason: "falha inesperada na instalação" },
    );
    if (result.ok) {
      onPhase({ phase: BOOT_PHASE.RESTARTING });
      // No Windows o instalador encerra este processo: o relaunch pode nem
      // ser alcançado, e o splash "Abrindo novamente…" cobre esse caso.
      await deps.relaunch();
      return { outcome: BOOT_OUTCOME.RESTARTING };
    }
    // Falhou (sem espaço, antivírus bloqueando, instalador corrompido):
    // avisa e abre a versão que já está no disco.
    onPhase({ phase: BOOT_PHASE.FAILED_UPDATE, reason: result.reason });
  }

  if (!isCloud) {
    onPhase({ phase: BOOT_PHASE.CONNECTING });
    if (!(await deps.pingApi(API_PROBE_TIMEOUT_MS))) {
      onPhase({ phase: BOOT_PHASE.OFFLINE, reason: "local" });
      return { outcome: BOOT_OUTCOME.OFFLINE, reason: "local" };
    }
  }

  onPhase({ phase: BOOT_PHASE.READY });
  return { outcome: BOOT_OUTCOME.READY };
}

import { playTones } from "@/shared/lib/audio";

// Som por TIPO de alerta. A chave é o `alert.kind` que o backend grava —
// `order_created` hoje, e a tabela cresce sem tocar em quem chama (é só
// acrescentar uma linha aqui).
//
// Os tons são deliberadamente agudos e curtos (880 Hz + a quinta 1174,7 Hz):
// é o som de balcão, para ser ouvido acima de uma cozinha barulhenta, e não o
// bip padrão de um celular. Nenhum arquivo de áudio: sintetizado, zero download.
//
// A preferência é POR DISPOSITIVO (`localStorage`), não por usuário nem em
// `store_settings`: quem liga o som é o tablet da mesa, e um tablet compartilhado
// entre o turno da manhã e o da noite não pode carregar a escolha do outro.
export const ALERT_SOUND_KEY = "pdv:alert-sound";

/**
 * Repetição do som enquanto o alerta continuar não lido. Um aviso de comanda
 * que ninguém ouve no primeiro toque é exatamente o que o sino resolve; 30s é
 * o corte — longo o bastante para o garçom terminar de fechar a comanda anterior,
 * curto o bastante para não virar alarme de tomography de salão.
 */
export const ALERT_REPEAT_MS = 30_000;

export const ALERT_SOUNDS = {
  // Comanda nova: dois bipes. O segundo um pouco depois, para não virar um
  // bipe que o ruído da cozinha mascara em meio segundo.
  order_created: {
    label: "Comanda nova",
    tones: [
      { freq: 880, at: 0, duration: 0.14, gain: 0.14 },
      { freq: 1174.7, at: 0.18, duration: 0.2, gain: 0.13 },
    ],
  },
};

/** Tipo desconhecido (alerta novo no backend, app velho em cache) não é erro. */
export function alertSound(kind) {
  return ALERT_SOUNDS[kind] ?? ALERT_SOUNDS.order_created;
}

/** Toca o som do alerta. `false` = tocou (ou nem deu), nunca lança. */
export function playAlertSound(kind) {
  return playTones(alertSound(kind).tones);
}

// ---------- Preferência por dispositivo ----------

export function isAlertSoundEnabled() {
  try {
    return localStorage.getItem(ALERT_SOUND_KEY) !== "off";
  } catch {
    return true; // storage bloqueado: o default (ligado) vale
  }
}

export function setAlertSoundEnabled(enabled) {
  try {
    localStorage.setItem(ALERT_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    /* aba anônima sem storage: o som funciona, só não persiste */
  }
  return enabled;
}

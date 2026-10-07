// Som por TIPO de alerta + preferência POR DISPOSITIVO.
//
// Port de `frontend/src/entities/alert/lib/sounds.js`. Duas trocas de ambiente,
// nenhuma de contrato:
//
//   1. O áudio é nativo (`expo-audio` via `./audio.native`), não Web Audio.
//   2. A preferência mora no adapter síncrono `@/shared/lib/storage` (MMKV com
//      API de `localStorage`), não em `AsyncStorage` — que nem está no
//      `package.json` deste app. Ler com `storage.getItem` mantém a
//      assinatura SÍNCRONA do web, que é o que os chamadores esperam:
//      `useNewDeliveryAlert` faz `if (isAlertSoundEnabled())` — virar Promise
//      tornaria a condição sempre verdadeira e desligar o som não teria efeito.
import { storage } from "@/shared/lib/storage";
import { playNativeAlertSound } from "./audio.native";

export const ALERT_SOUND_KEY = "pdv:alert-sound";

/** Repetição do som enquanto o alerta continuar não lido (mesmo valor do web). */
export const ALERT_REPEAT_MS = 30_000;

export const ALERT_SOUNDS = {
  order_created: {
    label: "Comanda nova",
  },
};

/** Tipo desconhecido (alerta novo no backend, app velho em cache) não é erro. */
export function alertSound(kind) {
  return ALERT_SOUNDS[kind] ?? ALERT_SOUNDS.order_created;
}

/** Toca o som do alerta. `true` = tentou tocar; nunca lança. */
export async function playAlertSound(kind) {
  await playNativeAlertSound();
  return true;
}

// ---------- Preferência por dispositivo ----------

export function isAlertSoundEnabled() {
  try {
    return storage.getItem(ALERT_SOUND_KEY) !== "off";
  } catch {
    return true; // storage bloqueado: o default (ligado) vale
  }
}

export function setAlertSoundEnabled(enabled) {
  try {
    storage.setItem(ALERT_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    /* storage indisponível: o som funciona, só não persiste */
  }
  return enabled;
}

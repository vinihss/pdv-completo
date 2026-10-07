// Credencial de longa duração do aparelho provisionado:
//   { deviceId, deviceToken, user }  — `docs/21-device-provisioning.md` §5.2.
//
// Fica no SecureStore (chave lógica `pdv:device`) e NÃO no MMKV: é o segredo
// revogável que destranca o aparelho, então merece a sandbox do keychain
// (`docs/21 §3`, decisão 4 e §11). O JWT da sessão continua no MMKV — ele morre
// em 12h e é descartável; a sessão persistente é o device token.
//
// O SecureStore só aceita chaves `[\w.-]+` (sem `:`), por isso a chave física é
// `pdv.device`, embora neste app o "nome" da credencial seja `pdv:device`.
//
// A preferência de biometria é UX e não é segredo: mora no MMKV, junto do
// resto das configurações do aparelho (`shared/lib/storage`).
import * as SecureStore from "expo-secure-store";
import { storage } from "@/shared/lib/storage";

const CREDENTIAL_KEY = "pdv.device";
const BIOMETRIC_KEY = "pdv:device:biometric";

/** Lê a credencial salva, ou `null` (sem credencial / JSON corrompido). */
export async function loadDeviceCredential() {
  try {
    const raw = await SecureStore.getItemAsync(CREDENTIAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.deviceId || !parsed?.deviceToken || !parsed?.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Grava a credencial (no primeiro provisionamento e a cada rotação de token). */
export async function saveDeviceCredential(credential) {
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(credential));
}

/** Apaga a credencial (aparelho revogado, usuário desativado, "esquecer"). */
export async function clearDeviceCredential() {
  try {
    await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
  } catch {
    // Credencial ausente não é erro: o efeito desejado (não ter credencial) já vale.
  }
}

/** Biometria habilitada pelo usuário neste aparelho? */
export function isBiometricEnabled() {
  return storage.getItem(BIOMETRIC_KEY) === "1";
}

/** Liga/desliga a preferência de biometria (não é segredo — MMKV). */
export function setBiometricPreference(enabled) {
  if (enabled) storage.setItem(BIOMETRIC_KEY, "1");
  else storage.removeItem(BIOMETRIC_KEY);
}

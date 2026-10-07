// Portado de frontend/src/app/providers/auth/AuthProvider.jsx, EVOLUÍDO para o
// device provisioning (`docs/21-device-provisioning.md`).
//
// Diferenças RN já existentes: a sessão (JWT) persiste no `storage` (MMKV);
// sem branding. O que muda agora é que existem DUAS credenciais:
//
//   - `session`          → JWT de 12h, no MMKV ("pdv:session"). Descartável.
//   - `deviceCredential` → {deviceId, deviceToken, user}, no SecureStore. É a
//                          credencial de longa duração do aparelho (§5.2) e o
//                          deviceToken ROTACIONA a cada refresh (§11).
//
// Ciclo (docs/21 §5.2/§5.3):
//   boot → carrega credencial (SecureStore é assíncrono; `booting` segura o
//          splash) → sem credencial: Provision; com credencial e sem sessão:
//          Lock (biometria ou PIN); com sessão: Main.
//   "Sair" é BLOQUEIO: derruba o JWT e MANTÉM a credencial. Não existe "trocar
//   usuário" em aparelho provisionado (§5.3).
//   device_revoked/device_unknown/device_not_provisioned → apaga a credencial e
//   volta para Provision (critérios 5/6 do §12).
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import * as LocalAuthentication from "expo-local-authentication";
import { login as loginApi } from "@/entities/session";
import { getStoreSettings } from "@/entities/store";
import {
  canonicalProvisioningCode,
  clearDeviceCredential,
  currentDeviceLabel,
  currentPlatform,
  exchangeProvisioningCode,
  isBiometricEnabled,
  isCredentialInvalidError,
  loadDeviceCredential,
  refreshDeviceSession,
  saveDeviceCredential,
  setBiometricPreference,
} from "@/entities/provisioning";
import { setAuthToken, setUnauthorizedHandler } from "@/shared/api/http";
import { storage } from "@/shared/lib/storage";
import { APP_VARIANT } from "@/shared/lib/variant";

const AuthContext = createContext(null);

const STORAGE_KEY = "pdv:session";

// Mensagem do prompt nativo. Fica aqui (e não na tela) para o desbloqueio
// automático do boot e o botão da tela de PIN usarem o mesmo texto.
const BIOMETRIC_PROMPT = {
  promptMessage: "Desbloqueie o PDV",
  cancelLabel: "Usar PIN",
};

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null); // { token, user }
  const [storeSettings, setStoreSettings] = useState(null);
  const [booting, setBooting] = useState(true);
  const [deviceCredential, setDeviceCredential] = useState(null);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  const applySession = useCallback((next) => {
    setAuthToken(next.token);
    setSession(next);
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    setAuthToken(null);
    storage.removeItem(STORAGE_KEY);
  }, []);

  // "Sair" = bloquear: perde o JWT, mantém a credencial do aparelho. É o
  // handler global de 401 (`setUnauthorizedHandler`) e a ação de bloqueio.
  const lock = useCallback(() => {
    clearSession();
  }, [clearSession]);

  const forgetDevice = useCallback(async () => {
    clearSession();
    await clearDeviceCredential();
    setDeviceCredential(null);
  }, [clearSession]);

  // Refresh de uma credencial explícita: o boot chama antes de o state existir.
  const performRefresh = useCallback(
    async (credential) => {
      const result = await refreshDeviceSession({
        deviceId: credential.deviceId,
        deviceToken: credential.deviceToken,
      });
      // O deviceToken rotaciona: persistir o NOVO é obrigatório (§11).
      const nextCredential = {
        ...credential,
        deviceToken: result.deviceToken,
        user: result.user ?? credential.user,
      };
      await saveDeviceCredential(nextCredential);
      setDeviceCredential(nextCredential);
      applySession({ token: result.token, user: nextCredential.user });
      return result;
    },
    [applySession],
  );

  const refreshWithDevice = useCallback(async () => {
    if (!deviceCredential) throw new Error("Sem credencial de aparelho");
    try {
      return await performRefresh(deviceCredential);
    } catch (error) {
      if (isCredentialInvalidError(error)) await forgetDevice();
      throw error;
    }
  }, [deviceCredential, performRefresh, forgetDevice]);

  const promptBiometric = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync(BIOMETRIC_PROMPT);
    if (!result?.success) {
      const error = new Error("biometria não confirmada");
      error.code = "biometric_cancelled";
      throw error;
    }
    return true;
  }, []);

  const unlockWithBiometrics = useCallback(async () => {
    await promptBiometric();
    return refreshWithDevice();
  }, [promptBiometric, refreshWithDevice]);

  const provision = useCallback(async (rawCode) => {
    const result = await exchangeProvisioningCode({
      code: canonicalProvisioningCode(rawCode),
      platform: currentPlatform(),
      appProfile: APP_VARIANT,
      deviceLabel: currentDeviceLabel(),
    });
    const credential = {
      deviceId: result.deviceId,
      deviceToken: result.deviceToken,
      user: result.user,
    };
    await saveDeviceCredential(credential);
    setDeviceCredential(credential);
    return result;
  }, []);

  const login = useCallback(
    async (userId, pin) => {
      // Com aparelho provisionado o login carrega o deviceId: o backend valida
      // o vínculo (docs/21 §5.3). Sem credencial, é o login antigo por grade.
      const deviceId = deviceCredential?.deviceId;
      try {
        const result = await loginApi(userId, pin, deviceId);
        applySession(result);
        return result;
      } catch (error) {
        if (isCredentialInvalidError(error)) await forgetDevice();
        throw error;
      }
    },
    [deviceCredential, applySession, forgetDevice],
  );

  const setBiometricEnabled = useCallback((enabled) => {
    setBiometricPreference(enabled);
    setBiometricEnabledState(Boolean(enabled));
  }, []);

  // Handler global de 401: bloqueia, sem apagar a credencial do aparelho.
  useEffect(() => {
    setUnauthorizedHandler(lock);
  }, [lock]);

  // Boot: restaura o JWT (MMKV, síncrono), carrega a credencial do aparelho
  // (SecureStore, assíncrono) e, se a biometria estiver ligada, tenta o
  // desbloqueio automático. `booting` segue true até o fim disto.
  useEffect(() => {
    let alive = true;

    (async () => {
      setBiometricEnabledState(isBiometricEnabled());
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (alive) setBiometricAvailable(Boolean(hasHardware && enrolled));
      } catch {
        if (alive) setBiometricAvailable(false);
      }

      let hasSession = false;
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setAuthToken(parsed.token);
          if (alive) setSession(parsed);
          hasSession = true;
        } catch {
          storage.removeItem(STORAGE_KEY);
        }
      }

      let credential = null;
      try {
        credential = await loadDeviceCredential();
      } catch {
        credential = null;
      }

      if (alive && credential) {
        setDeviceCredential(credential);
        // Só faz sentido o desbloqueio automático quando não há sessão viva.
        if (!hasSession && isBiometricEnabled()) {
          try {
            await promptBiometric();
            await performRefresh(credential);
          } catch {
            // Cancelou/falhou: cai na tela de PIN (fallback do §5.3).
          }
        }
      }

      if (alive) setBooting(false);
    })();

    return () => {
      alive = false;
    };
  }, [performRefresh, promptBiometric]);

  useEffect(() => {
    if (!session) {
      setStoreSettings(null);
      return;
    }
    getStoreSettings()
      .then(setStoreSettings)
      .catch(() => {});
  }, [session]);

  const refreshStoreSettings = useCallback(async () => {
    const s = await getStoreSettings();
    setStoreSettings(s);
    return s;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        login,
        lock,
        forgetDevice,
        provision,
        refreshWithDevice,
        unlockWithBiometrics,
        booting,
        deviceCredential,
        biometricEnabled,
        biometricAvailable,
        setBiometricEnabled,
        storeSettings,
        refreshStoreSettings,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return ctx;
}

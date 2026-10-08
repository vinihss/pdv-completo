import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { login as loginApi, updateMe } from "@/entities/session";
import { getStoreSettings } from "@/entities/store";
import { setAuthToken, setUnauthorizedHandler } from "@/shared/api/http";
import { applyBrandPrimary } from "@/shared/lib";

const AuthContext = createContext(null);

const STORAGE_KEY = "pdv:session";

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null); // { token, user: {id,name,role,photoPath} }
  const [storeSettings, setStoreSettings] = useState(null);
  const [booting, setBooting] = useState(true);

  const logout = useCallback(() => {
    setSession(null);
    setAuthToken(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  // Restaura sessão da aba (terminal compartilhado — não persiste entre
  // dispositivos, só sobrevive a um refresh acidental da mesma aba).
  useEffect(() => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        setAuthToken(parsed.token);
        setSession(parsed);
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
    setBooting(false);
  }, []);

  useEffect(() => {
    if (!session) {
      setStoreSettings(null);
      applyBrandPrimary(); // volta ao padrão na tela de login
      return;
    }
getStoreSettings()
      .then((s) => {
        setStoreSettings(s);
        applyBrandPrimary(s?.brandColor);
        if (s?.merchantName) document.title = `${s.merchantName} — PDV`;
      })
      .catch(() => {});
  }, [session]);

  const login = useCallback(async (userId, pin) => {
    const result = await loginApi(userId, pin);
    setAuthToken(result.token);
    setSession(result);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    return result;
  }, []);

  const refreshStoreSettings = useCallback(async () => {
    const s = await getStoreSettings();
    setStoreSettings(s);
    applyBrandPrimary(s?.brandColor);
    return s;
  }, []);

  // PATCH /auth/me: atualiza name/phone/email do próprio usuário e reflete na
  // sessão (header, menu e telas) sem precisar de logout/login.
  const updateProfile = useCallback(async (patch) => {
    const res = await updateMe(patch);
    setSession((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        user: { ...prev.user, ...(res && typeof res === "object" ? res : {}), ...patch },
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    return res;
  }, []);

  return (
    <AuthContext.Provider value={{ session, login, logout, booting, storeSettings, refreshStoreSettings, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return ctx;
}
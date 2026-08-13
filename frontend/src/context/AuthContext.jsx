import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, setAuthToken, setUnauthorizedHandler } from "../lib/api.js";

const AuthContext = createContext(null);

const STORAGE_KEY = "pdv:session";

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null); // { token, user: {id,name,role} }
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
      return;
    }
    api
      .getStoreSettings()
      .then(setStoreSettings)
      .catch(() => {});
  }, [session]);

  const login = useCallback(async (userId, pin) => {
    const result = await api.login(userId, pin);
    setAuthToken(result.token);
    setSession(result);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    return result;
  }, []);

  const refreshStoreSettings = useCallback(async () => {
    const s = await api.getStoreSettings();
    setStoreSettings(s);
    return s;
  }, []);

  return (
    <AuthContext.Provider value={{ session, login, logout, booting, storeSettings, refreshStoreSettings }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return ctx;
}

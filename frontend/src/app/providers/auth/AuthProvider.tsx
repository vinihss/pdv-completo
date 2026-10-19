import {
  decodeTokenExp,
  login as loginApi,
  logoutSession,
  refreshSession,
  selectTenant,
  sessionStart,
  changePassword,
  setDeviceTenantSlug,
  updateMe,
} from "@/entities/session";
import { getStoreSettings } from "@/entities/store";
import { setAuthToken, setUnauthorizedHandler } from "@/shared/api/http";
import { applyBrandPrimary } from "@/shared/lib";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const AuthContext = createContext(null);

const STORAGE_KEY = "pdv:session";
// Sessão perto do fim da vida é girada no boot ANTES da primeira chamada da
// tela (docs/26 §5): menos que isso e o refresh vale a pena adiar.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- persistência
// "Lembrar de mim" escolhe o DONO da sessão: localStorage sobrevive ao browser
// (computador fixo do gerente), sessionStorage é o comportamento antigo de
// terminal compartilhado do salão — só sobrevive a um refresh da mesma aba.
// A forma gravada é sempre { token, refreshToken, user }.
function readPersistedSession() {
  const inLocal = localStorage.getItem(STORAGE_KEY);
  if (inLocal) return { raw: inLocal, storage: localStorage };
  const inSession = sessionStorage.getItem(STORAGE_KEY);
  return { raw: inSession, storage: sessionStorage };
}

function persistSession(data, storage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function clearPersistedSession() {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
}

// Guarda de rotação em nível de MÓDULO (não de componente): no StrictMode o
// boot roda duas vezes e um 401 em cascata dispara o handler N vezes — sem um
// guard compartilhado, a mesma família de refresh giraria dois tokens em
// paralelo, e o backend trata o segundo como REUSO e revoga a família inteira.
let refreshInFlight = null;
function rotateRefresh(current) {
  if (!refreshInFlight) {
    refreshInFlight = refreshSession(current.refreshToken)
      .then((res) => ({
        ...current,
        token: res.token,
        refreshToken: res.refreshToken ?? current.refreshToken,
      }))
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null); // { token, refreshToken, user: {id,name,role,photoPath} }
  // Etapa de conta da identidade centralizada (docs/26 §5): existe só entre o
  // POST /auth/session e o POST /auth/select-tenant. Fica EM MEMÓRIA — o
  // accountToken não é persistido de propósito (vida de 10min, sai da aba no refresh).
  const [account, setAccount] = useState(null); // { accountToken, mustChangePassword, companies, remember }
  const [storeSettings, setStoreSettings] = useState(null);
  const [booting, setBooting] = useState(true);

  // Espelhos síncronos para os callbacks (o handler de 401 precisa ler a
  // sessão atual no instante do 401, sem esperar um re-render).
  const sessionRef = useRef(null);
  const accountRef = useRef(null);
  // Alvo de persistência da sessão corrente (localStorage ou sessionStorage).
  const storageRef = useRef(sessionStorage);

  const applySession = useCallback((next, remember) => {
    const storage = remember ? localStorage : sessionStorage;
    storageRef.current = storage;
    persistSession(next, storage);
    // Limpa o outro storage: trocar de "lembrar" no meio de uma sessão não
    // pode deixar uma sessão zumbi viva no terminal compartilhado.
    (remember ? sessionStorage : localStorage).removeItem(STORAGE_KEY);
    setAuthToken(next.token);
    sessionRef.current = next;
    setSession(next);
  }, []);

  const clearSession = useCallback(() => {
    clearPersistedSession();
    setAuthToken(null);
    sessionRef.current = null;
    setSession(null);
  }, []);

  const logout = useCallback(() => {
    // Revoga a sessão no servidor (idempotente). Fire-and-forget: o logout do
    // app não pode ficar refém de uma rede ruim — o token local já morreu aqui.
    const refreshToken = sessionRef.current?.refreshToken;
    if (refreshToken) logoutSession(refreshToken).catch(() => {});
    accountRef.current = null;
    setAccount(null);
    clearSession();
  }, [clearSession]);

  // Um "401 com sessão viva" pode ser só o token de 12h vencendo no meio do
  // turno: tenta UM refresh (rotação); falhou, desloga limpo (docs/26 §5).
  const handleUnauthorized = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return; // sem sessão: 401 é resposta esperada (ex.: senha errada no login)
    if (!current.refreshToken) {
      clearSession(); // sessão por PIN (fallback) não tem refresh: morre aqui
      return;
    }
    try {
      const next = await rotateRefresh(current);
      setAuthToken(next.token);
      sessionRef.current = next;
      setSession(next);
      persistSession(next, storageRef.current);
    } catch {
      clearSession();
    }
  }, [clearSession]);

  useEffect(() => {
    setUnauthorizedHandler(handleUnauthorized);
  }, [handleUnauthorized]);

  // Boot: restaura a sessão persistida (localStorage primeiro, senão
  // sessionStorage) e, se o token estiver com < 5min de vida, gira o refresh
  // antes de deixar o app fazer a primeira chamada. Falhou → logout limpo.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { raw, storage } = readPersistedSession();
      if (!raw) {
        setBooting(false);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        clearPersistedSession();
        setBooting(false);
        return;
      }
      if (!parsed?.token || !parsed?.user) {
        clearPersistedSession();
        setBooting(false);
        return;
      }

      const exp = decodeTokenExp(parsed.token);
      const expiresIn = exp ? exp * 1000 - Date.now() : Number.POSITIVE_INFINITY;
      if (expiresIn < REFRESH_MARGIN_MS) {
        if (!parsed.refreshToken) {
          // Sessão por PIN (fallback /login/pin) não tem refresh: perto do
          // fim da vida o caminho certo é pedir o login de novo.
          clearPersistedSession();
          setBooting(false);
          return;
        }
        try {
          parsed = await rotateRefresh(parsed);
          persistSession(parsed, storage);
        } catch {
          clearPersistedSession();
          setBooting(false);
          return;
        }
      }
      if (!alive) return;
      storageRef.current = storage;
      sessionRef.current = parsed;
      setAuthToken(parsed.token);
      setSession(parsed);
      setBooting(false);
    })();
    return () => {
      alive = false;
    };
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

  // ---- Login por PIN (rota fallback /login/pin — comportamento anterior, intacto)
  const login = useCallback(
    async (userId, pin) => {
      const result = await loginApi(userId, pin);
      // PIN não tem refreshToken: a sessão morre no boot se estiver perto do
      // fim da vida (sem rotação possível), igual ao comportamento antigo.
      applySession(result, false);
      return result;
    },
    [applySession]
  );

  // ---- Identidade centralizada (docs/26 §5): conta global → troca de senha
  // obrigatória (quando aplicável) → seleção de empresa → sessão de tenant.

  /** Estágio 1: valida credenciais e abre a etapa de conta (em memória). */
  const loginNovo = useCallback(async (email, password, remember) => {
    const res = await sessionStart(email, password);
    const next = {
      accountToken: res.accountToken,
      mustChangePassword: Boolean(res.mustChangePassword),
      companies: res.companies ?? [],
      remember: Boolean(remember),
    };
    accountRef.current = next;
    setAccount(next);
    return next;
  }, []);

  /** Troca de senha temporária → definitiva (obrigatória antes da seleção). */
  const changeAccountPassword = useCallback(async (newPassword) => {
    const current = accountRef.current;
    if (!current?.accountToken) throw new Error("Sessão expirada. Entre novamente.");
    await changePassword(current.accountToken, newPassword);
    const next = { ...current, mustChangePassword: false };
    accountRef.current = next;
    setAccount(next);
    return next;
  }, []);

  /** Estágio final: troca o accountToken pela sessão de tenant da empresa escolhida. */
  const completeTenantSelection = useCallback(
    async (slug) => {
      const current = accountRef.current;
      if (!current?.accountToken) throw new Error("Sessão expirada. Entre novamente.");
      const res = await selectTenant(current.accountToken, slug);
      const next = { token: res.token, refreshToken: res.refreshToken, user: res.user };
      // Preferência do dispositivo (docs/26 §2, decisão 6): gravada após o
      // select-tenant DAR CERTO — nunca antes, para o atalho nunca sugerir uma
      // empresa cujo vínculo o backend recusou.
      setDeviceTenantSlug(slug);
      applySession(next, current.remember);
      accountRef.current = null;
      setAccount(null);
      return next;
    },
    [applySession]
  );

  /** Desiste da etapa de conta (voltar para o login sem perder a aba aberta). */
  const cancelAccountStage = useCallback(() => {
    accountRef.current = null;
    setAccount(null);
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
      sessionRef.current = next;
      persistSession(next, storageRef.current);
      return next;
    });
    return res;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        account,
        login,
        loginNovo,
        changeAccountPassword,
        completeTenantSelection,
        cancelAccountStage,
        logout,
        booting,
        storeSettings,
        refreshStoreSettings,
        updateProfile,
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

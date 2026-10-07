// Novo: única fonte de "qual servidor está configurado" (é o boot do app puro
// que o web resolve com `injectBootConfig`). No aparelho não existe origem da
// página: ou o gestor configurou um servidor na tela de setup, ou o app fica
// trancado nela até configurar.
import { createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import { getDaemonBase, getServerBase, setDaemonBase, setServerBase } from "@/shared/lib/server";
import { isApiConfigured, setAppConfig } from "@/shared/lib/appConfig";

const AppConfigContext = createContext(null);

export function AppConfigProvider({ children }) {
  const [configured, setConfigured] = useState(false);

  // Boot: rega a config global a partir do que está persistido (MMKV). Se o
  // servidor salvo tiver caído, quem mostra o aviso é a tela de login — aqui
  // não tem nada para "pingar" ainda, e bloquear o app num servidor morto
  // tampando o login seria a pior saída (o web também confia na base salva).
  useEffect(() => {
    setAppConfig({ apiBase: getServerBase(), daemonUrl: getDaemonBase() });
    setConfigured(isApiConfigured());
  }, []);

  const applyServer = useCallback(
    (origin, deps = {}) => {
      const save = setServerBase(origin);
      if (!save.ok) return save;
      const daemonUrl = deps.daemonUrl !== undefined ? deps.daemonUrl : getDaemonBase();
      if (deps.daemonUrl !== undefined) setDaemonBase(deps.daemonUrl);
      setAppConfig({ apiBase: origin, daemonUrl });
      setConfigured(Boolean(origin));
      return { ok: true, value: origin };
    },
    [],
  );

  const clearServer = useCallback(() => {
    setServerBase("");
    setAppConfig(null);
    setConfigured(false);
  }, []);

  const value = useMemo(
    () => ({
      configured,
      serverBase: getServerBase(),
      daemonUrl: getDaemonBase(),
      applyServer,
      clearServer,
    }),
    [configured, applyServer, clearServer],
  );

  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig() {
  const ctx = useContext(AppConfigContext);
  if (!ctx) throw new Error("useAppConfig precisa estar dentro de <AppConfigProvider>");
  return ctx;
}
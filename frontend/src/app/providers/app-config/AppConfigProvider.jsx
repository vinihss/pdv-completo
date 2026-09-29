import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { normalizeConfig, setAppConfig } from "@/shared/lib";
import { loadAppConfig, persistAppConfig, clearAppConfig } from "./api.js";

const AppConfigContext = createContext(null);

/**
 * Carrega a config do aplicativo (modo local × cloud) e a publica para o
 * resto do app. `config` é null no web — lá a API é sempre a mesma origem,
 * então o comportamento de sempre não muda.
 */
export function AppConfigProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    loadAppConfig()
      .then((raw) => {
        if (!alive) return;
        // Sempre publica, inclusive `null`: config apagada precisa limpar a
        // URL que ficou em memória, senão o app continua falando com a API
        // antiga depois do reset.
        const next = raw ? normalizeConfig(raw) : null;
        setConfig(next);
        setAppConfig(next);
      })
      .catch((err) => {
        // Sem config o app ainda abre: a tela de setup aparece e o gestor
        // preenche. Falha de leitura não pode travar o boot.
        if (alive) setError(err);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (next) => {
    setSaving(true);
    setError(null);
    try {
      const saved = normalizeConfig(await persistAppConfig(next));
      setConfig(saved);
      setAppConfig(saved);
      return saved;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  // Volta ao padrão escrito pelo instalador (%ProgramData%\PDV\app.json).
  const restoreDefault = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await clearAppConfig();
      const raw = await loadAppConfig();
      const next = raw ? normalizeConfig(raw) : null;
      setConfig(next);
      setAppConfig(next);
      return next;
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <AppConfigContext.Provider value={{ config, loading, saving, error, save, restoreDefault }}>
      {children}
    </AppConfigContext.Provider>
  );
}

export function useAppConfig() {
  const ctx = useContext(AppConfigContext);
  if (!ctx) throw new Error("useAppConfig precisa estar dentro de <AppConfigProvider>");
  return ctx;
}

import { getIfoodStatus, syncIfoodCatalog } from "@/entities/ifood";
import { RefreshCcw } from "lucide-react";
import React, { useState, useCallback, useEffect } from "react";

export default function IfoodTab({ showToast }) {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => {
    getIfoodStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSync = async () => {
    setSyncing(true);
    try {
      const r = await syncIfoodCatalog();
      showToast(
        `Catálogo sincronizado (${r.items.sent} itens, ${r.categories} categorias)`,
        "success"
      );
      refresh();
    } catch (e) {
      showToast(e?.message ?? "Falha ao sincronizar catálogo", "error");
    } finally {
      setSyncing(false);
    }
  };

  if (!status) {
    return (
      <div className="p-5 max-w-xl mx-auto text-center text-text-muted py-12">
        Integração iFood não configurada (env/credenciais) ou indisponível.
      </div>
    );
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");

  return (
    <div className="p-5 max-w-xl mx-auto space-y-4">
      <div className="bg-surface border border-border rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm">Integração iFood</span>
          <span
            className={`text-xs font-bold px-2.5 py-1 rounded-full ${status.enabled ? "bg-success-fill text-success-foreground" : "bg-destructive/15 text-destructive"}`}
          >
            {status.enabled ? "Ativa" : "Desativada"}
          </span>
        </div>
        {status.mock && (
          <div className="text-xs text-primary bg-primary/10 border border-ring/20 rounded-lg px-2.5 py-1.5">
            Modo de demonstração (mock) — sem credenciais reais.
          </div>
        )}
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between">
            <dt className="text-text-muted">Mercado</dt>
            <dd>{status.merchantName ?? status.merchantId ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Último poll</dt>
            <dd>{fmtTime(status.lastPollAt)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Catálogo (última sync)</dt>
            <dd>{fmtTime(status.lastCatalogSyncAt)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Pedidos iFood locais</dt>
            <dd>{status.ordersIngested}</dd>
          </div>
        </dl>
        {status.lastPollError && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-2.5 py-1.5">
            Erro no poll: {status.lastPollError}
          </div>
        )}
        {status.events && Object.keys(status.events).length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {Object.entries(status.events).map(([k, v]) => (
              <span
                key={k}
                className="bg-surface-overlay rounded-full px-2 py-0.5 text-text-secondary"
              >
                {k}: <b className="text-text-secondary">{v}</b>
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onSync}
        disabled={syncing}
        className="w-full bg-primary hover:bg-primary-strong disabled:opacity-50 text-primary-foreground font-semibold py-3 rounded-xl flex items-center justify-center gap-2"
      >
        <RefreshCcw size={16} className={syncing ? "animate-spin" : ""} />
        {syncing ? "Sincronizando…" : "Sincronizar catálogo com o iFood"}
      </button>
    </div>
  );
}

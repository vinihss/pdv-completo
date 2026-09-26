import React, { useState, useCallback, useEffect } from "react";
import { RefreshCcw } from "lucide-react";
import { getIfoodStatus, syncIfoodCatalog } from "@/entities/ifood";

export default function IfoodTab({ showToast }) {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => {
    getIfoodStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSync = async () => {
    setSyncing(true);
    try {
      const r = await syncIfoodCatalog();
      showToast(`Catálogo sincronizado (${r.items.sent} itens, ${r.categories} categorias)`, "success");
      refresh();
    } catch (e) {
      showToast(e?.message ?? "Falha ao sincronizar catálogo", "error");
    } finally {
      setSyncing(false);
    }
  };

  if (!status) {
    return (
      <div className="p-5 max-w-xl mx-auto text-center text-stone-500 py-12">
        Integração iFood não configurada (env/credenciais) ou indisponível.
      </div>
    );
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");

  return (
    <div className="p-5 max-w-xl mx-auto space-y-4">
      <div className="bg-stone-900 border border-stone-800 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm">Integração iFood</span>
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${status.enabled ? "bg-emerald-500 text-emerald-950" : "bg-red-500/15 text-red-400"}`}>
            {status.enabled ? "Ativa" : "Desativada"}
          </span>
        </div>
        {status.mock && <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5">Modo de demonstração (mock) — sem credenciais reais.</div>}
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-stone-500">Mercado</dt><dd>{status.merchantName ?? status.merchantId ?? "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-500">Último poll</dt><dd>{fmtTime(status.lastPollAt)}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-500">Catálogo (última sync)</dt><dd>{fmtTime(status.lastCatalogSyncAt)}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-500">Pedidos iFood locais</dt><dd>{status.ordersIngested}</dd></div>
        </dl>
        {status.lastPollError && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">Erro no poll: {status.lastPollError}</div>}
        {status.events && Object.keys(status.events).length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {Object.entries(status.events).map(([k, v]) => (
              <span key={k} className="bg-stone-800 rounded-full px-2 py-0.5 text-stone-400">{k}: <b className="text-stone-200">{v}</b></span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onSync}
        disabled={syncing}
        className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl flex items-center justify-center gap-2"
      >
        <RefreshCcw size={16} className={syncing ? "animate-spin" : ""} />
        {syncing ? "Sincronizando…" : "Sincronizar catálogo com o iFood"}
      </button>
    </div>
  );
}
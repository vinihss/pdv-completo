import React, { useState, useCallback, useEffect, useRef } from "react";
import { Search, ArrowRightLeft, History, AlertTriangle, PackageSearch } from "lucide-react";
import { listStock, inventoryValue } from "@/entities/stock";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { formatBRL } from "@/shared/lib";
import { inputClass } from "@/shared/components";
import MovementModal from "./MovementModal.jsx";
import MovementsList from "./MovementsList.jsx";

// Estoque baixo: saldo <= limite cadastrado no produto (definido no backend).
function badgeFor(qty, low) {
  if (low) return "bg-amber-500/15 text-amber-400 border-amber-500/40";
  if (qty <= 0) return "bg-red-500/15 text-red-400 border-red-500/40";
  return "bg-emerald-500/15 text-emerald-400 border-emerald-500/40";
}

// A tab Estoque só existe com a feature ligada (storeSettings.inventoryEnabled);
// aqui o único gate restante é o live-reload pelo room "inventory".
export default function StockTab({ showToast, purchaseEnabled = false }) {
  const { session } = useAuth();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [valuation, setValuation] = useState(null);
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [movementTarget, setMovementTarget] = useState(null);
  const [historyTarget, setHistoryTarget] = useState(null);
  const searchRef = useRef("");
  searchRef.current = search;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (lowOnly) params.low_only = "true";
      if (searchRef.current.trim()) params.q = searchRef.current.trim();
      const res = await listStock(params);
      setRows(res.data);
      setTotal(res.total);
      if (purchaseEnabled) {
        const v = await inventoryValue();
        setValuation(v.totalValue);
      }
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowOnly, purchaseEnabled]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [search, load]);

  // Realtime: movimentos de estoque (venda/estorno no balcão, compra/ajuste
  // aqui) e alertas de estoque baixo atualizam a lista em qualquer aba aberta.
  const handleEvent = useCallback(
    (msg) => {
      if (msg.type === "stock.movement" || msg.type === "stock.low") load();
    },
    [load]
  );
  useRealtime(session?.token, ["inventory"], handleEvent);

  const lowCount = rows.filter((r) => r.low).length;

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-4">
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[160px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar produto com estoque..."
            className={inputClass + " pl-9"}
          />
        </div>
        <button
          onClick={() => setLowOnly(!lowOnly)}
          className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold border transition-colors ${
            lowOnly ? "bg-amber-500 text-stone-950 border-amber-500" : "bg-stone-900 border-stone-800 text-stone-400"
          }`}
        >
          <AlertTriangle size={14} />
          Só estoque baixo {lowCount > 0 && !lowOnly ? `(${lowCount})` : ""}
        </button>
      </div>

      {purchaseEnabled && valuation != null && (
        <div className="flex items-center justify-between bg-stone-900 border border-stone-800 rounded-xl px-3 py-2.5">
          <div className="text-stone-400 text-sm">Valorização do estoque</div>
          <div className="font-display font-bold text-lg">{formatBRL(valuation)}</div>
        </div>
      )}

      {lowCount > 0 && !lowOnly && (
        <div className="flex items-center gap-2 text-amber-400 text-sm bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
          <AlertTriangle size={14} /> {lowCount} produto(s) abaixo do limite de estoque.
        </div>
      )}

      {loading ? (
        <div className="text-stone-600 text-center py-12 text-sm">Carregando…</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.productId} className="flex items-center justify-between gap-3 bg-stone-900 border border-stone-800 rounded-xl px-3 py-2.5">
              <div className="min-w-0">
                <div className="font-medium text-sm flex items-center gap-2">
                  {r.name}
                  <span className={`text-[10px] font-bold rounded-full border px-1.5 py-0.5 shrink-0 ${badgeFor(r.quantity, r.low)}`}>
                    {r.low ? `Estoque baixo` : r.quantity <= 0 ? "Sem estoque" : "OK"}
                  </span>
                </div>
                <div className="text-stone-500 text-xs truncate">
                  {r.categoryName ?? "Sem categoria"}
                  {r.unit ? ` · ${r.unit}` : ""}
                  {r.averageCost > 0 ? ` · custo médio ${formatBRL(r.averageCost)}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <div className={`font-display font-bold ${r.low ? "text-amber-400" : r.quantity <= 0 ? "text-red-400" : "text-stone-100"}`}>
                    {r.quantity}{r.unit ? ` ${r.unit}` : ""}
                  </div>
                  <div className="text-stone-500 text-[11px]">limite {r.lowStockThreshold}</div>
                </div>
                <button
                  onClick={() => setHistoryTarget(r)}
                  title="Ver movimentos"
                  className="p-2 rounded-lg bg-stone-800 hover:bg-stone-750 border border-stone-700 text-stone-300"
                >
                  <History size={15} />
                </button>
                <button
                  onClick={() => setMovementTarget(r)}
                  title="Entrada ou ajuste"
                  className="p-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-stone-950"
                >
                  <ArrowRightLeft size={15} />
                </button>
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="text-stone-600 text-center py-16">
              <PackageSearch size={32} className="mx-auto mb-2 opacity-50" />
              <div className="text-sm">Nenhum produto com estoque{lowOnly ? " baixo" : ""} encontrado.</div>
              {!lowOnly && total === 0 && (
                <div className="text-xs mt-1">Ative "Rastreia estoque" no cadastro do produto e informe o saldo inicial.</div>
              )}
            </div>
          )}
        </div>
      )}

      {movementTarget && (
        <MovementModal
          product={movementTarget}
          onClose={() => setMovementTarget(null)}
          onSaved={async () => {
            setMovementTarget(null);
            await load();
          }}
          showToast={showToast}
        />
      )}
      {historyTarget && (
        <MovementsList
          productId={historyTarget.productId}
          productName={historyTarget.name}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}
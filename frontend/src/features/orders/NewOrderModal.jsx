import React, { useState, useEffect } from "react";
import { X } from "lucide-react";
import { listTables } from "@/entities/table";
import { searchCustomers, createCustomer } from "@/entities/customer";
import { Modal } from "@/shared/components";

export default function NewOrderModal({ usesTables, ordersByTable = {}, onClose, onConfirm, onOpenExisting }) {
  const [mode, setMode] = useState(usesTables ? "table" : "tab");
  const [tableId, setTableId] = useState("");
  const [tables, setTables] = useState([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [tabLabel, setTabLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (usesTables) listTables().then(setTables).catch(() => {});
  }, [usesTables]);

  useEffect(() => {
    if (mode !== "customer" || !customerQuery) {
      setCustomerResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchCustomers(customerQuery).then(setCustomerResults).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [mode, customerQuery]);

  async function handleConfirm() {
    setError(null);
    let identification = {};
    if (mode === "table") {
      if (!tableId) return setError("Selecione uma mesa.");
      
      // Verifica se já existe comanda aberta para esta mesa
      const existingOrder = ordersByTable[tableId];
      if (existingOrder && onOpenExisting) {
        // Abre a comanda existente em vez de criar nova
        setSubmitting(true);
        onOpenExisting(existingOrder.id);
        setSubmitting(false);
        return;
      }
      
      identification = { tableId };
    } else if (mode === "customer") {
      if (!selectedCustomer) return setError("Selecione ou cadastre um cliente.");
      identification = { customerId: selectedCustomer.id };
    } else {
      if (!tabLabel.trim()) return setError("Informe um rótulo para a comanda.");
      identification = { tabLabel: tabLabel.trim() };
    }
    setSubmitting(true);
    await onConfirm(identification);
    setSubmitting(false);
  }

  // Determina se a mesa selecionada tem comanda aberta
  const selectedTableHasOrder = mode === "table" && tableId && ordersByTable[tableId];

  async function handleQuickCreateCustomer() {
    if (!customerQuery.trim()) return;
    const created = await createCustomer({ name: customerQuery.trim() });
    setSelectedCustomer(created);
  }

  return (
    <Modal
      title="Nova comanda"
      onClose={onClose}
      footer={
        <button
          onClick={handleConfirm}
          disabled={submitting}
          className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 font-semibold py-3.5 rounded-xl transition-colors"
        >
          {submitting 
            ? "Abrindo…" 
            : selectedTableHasOrder 
            ? "Continuar comanda" 
            : "Abrir comanda"}
        </button>
      }
    >
      <div className="p-5">
        <div className="flex gap-2 mb-5">
          {usesTables && (
            <button
              type="button"
              onClick={() => setMode("table")}
              aria-pressed={mode === "table"}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold ${mode === "table" ? "bg-amber-500 text-stone-950" : "bg-stone-800 text-stone-400"}`}
            >
              Mesa
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("customer")}
            aria-pressed={mode === "customer"}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${mode === "customer" ? "bg-amber-500 text-stone-950" : "bg-stone-800 text-stone-400"}`}
          >
            Cliente
          </button>
          <button
            type="button"
            onClick={() => setMode("tab")}
            aria-pressed={mode === "tab"}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${mode === "tab" ? "bg-amber-500 text-stone-950" : "bg-stone-800 text-stone-400"}`}
          >
            Rótulo
          </button>
        </div>

        {mode === "table" && (
          <>
            <div className="grid grid-cols-4 gap-2 mb-3">
              {tables.map((t) => {
                const occupied = t.status === "occupied";
                const hasOrder = !!ordersByTable[t.id];
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTableId(t.id)}
                    aria-label={`Mesa ${t.number} (${occupied ? "ocupada" : "livre"})${hasOrder ? " - continuar comanda" : ""}`}
                    title={`Mesa ${t.number} (${occupied ? "ocupada" : "livre"})${hasOrder ? " - continuar comanda" : ""}`}
                    aria-pressed={tableId === t.id}
                    className={`py-3 rounded-xl font-display font-bold text-sm relative ${
                      tableId === t.id
                        ? "bg-amber-500 text-stone-950"
                        : hasOrder
                        ? "bg-blue-800/50 text-blue-300 hover:bg-blue-800/70"
                        : occupied
                        ? "bg-stone-800/50 text-stone-700 cursor-not-allowed"
                        : "bg-stone-800 text-stone-200"
                    }`}
                  >
                    {t.number}
                    {hasOrder && (
                      <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-400 rounded-full border-2 border-stone-900" />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-4 mb-4 text-xs text-stone-400">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-stone-800 border border-stone-700" aria-hidden="true" />
                Disponível
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-blue-800/50 border border-blue-700/50" aria-hidden="true" />
                Com comanda
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-stone-800/50 border border-stone-700/50" aria-hidden="true" />
                Ocupada
              </span>
            </div>
          </>
        )}

        {mode === "customer" && (
          <div className="mb-4">
            <input
              value={customerQuery}
              onChange={(e) => {
                setCustomerQuery(e.target.value);
                setSelectedCustomer(null);
              }}
              autoFocus
              placeholder="Nome do cliente..."
              className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-amber-500/50 mb-2"
            />
            {selectedCustomer ? (
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm">
                <span>{selectedCustomer.name}</span>
                <button onClick={() => setSelectedCustomer(null)} className="text-stone-400">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCustomer(c)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone-800 text-sm"
                  >
                    {c.name} {c.phone ? <span className="text-stone-500">· {c.phone}</span> : null}
                  </button>
                ))}
                {customerQuery && customerResults.length === 0 && (
                  <button onClick={handleQuickCreateCustomer} className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone-800 text-sm text-amber-400">
                    + Cadastrar "{customerQuery}"
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {mode === "tab" && (
          <input
            value={tabLabel}
            onChange={(e) => setTabLabel(e.target.value)}
            autoFocus
            placeholder="Ex: Comanda 12"
            className="w-full bg-stone-800 border border-stone-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-amber-500/50 mb-4"
          />
        )}

        {error && <div className="text-red-400 text-xs font-medium">{error}</div>}
      </div>
    </Modal>
  );
}
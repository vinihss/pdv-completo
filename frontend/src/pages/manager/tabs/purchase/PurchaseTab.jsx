import React, { useState, useCallback, useEffect } from "react";
import { Plus, Truck, PackagePlus, ChevronRight } from "lucide-react";
import { listSuppliers, listPurchases, getPurchase, updateSupplier, listStock } from "@/entities/stock";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { formatBRL, formatDateTime } from "@/shared/lib";
import { ToggleRow, Modal } from "@/shared/components";
import NewPurchaseModal from "./NewPurchaseModal.jsx";
import SupplierModal from "./SupplierModal.jsx";

// Lista de fornecedores + toggle ativo (edição inline simples).
function SuppliersList({ suppliers, onChanged, onOpenCreate, onClose, showToast }) {
  async function toggle(s) {
    try {
      await updateSupplier(s.id, { active: !s.active });
      onChanged();
    } catch (e) {
      showToast(e.message, "error");
    }
  }
  return (
    <Modal title="Fornecedores" onClose={onClose}>
      <div className="p-5 space-y-2">
        {suppliers.map((s) => (
          <div key={s.id} className="bg-stone-800/60 rounded-xl px-3 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{s.name}</div>
              <div className="text-stone-500 text-[11px] truncate">
                {s.phone ?? "Sem telefone"}
                {s.taxId ? ` · ${s.taxId}` : ""}
              </div>
            </div>
            <div className="shrink-0 w-24">
              <ToggleRow label="" checked={s.active} onChange={() => toggle(s)} />
            </div>
          </div>
        ))}
        {suppliers.length === 0 && (
          <div className="text-stone-600 text-center py-10 text-sm">Nenhum fornecedor cadastrado.</div>
        )}
        <button onClick={onOpenCreate} className="flex items-center gap-1.5 text-amber-500 text-sm font-semibold">
          <Plus size={14} /> Novo fornecedor
        </button>
      </div>
    </Modal>
  );
}

// Detalhe da compra: linhas + custo médio atual de cada produto envolvido.
// O Modal fica montado durante o carregamento (com "Carregando…" no corpo) para
// não piscar: antes, `return null` desmontava a tela inteira.
function PurchaseDetail({ purchaseId, onClose }) {
  const [purchase, setPurchase] = useState(null);
  useEffect(() => {
    getPurchase(purchaseId)
      .then(setPurchase)
      .catch(() => onClose());
  }, [purchaseId, onClose]);

  return (
    <Modal title="Compra" onClose={onClose}>
      <div className="p-5">
        {!purchase ? (
          <div className="text-stone-600 text-center py-10 text-sm">Carregando…</div>
        ) : (
          <>
            <div className="text-stone-500 text-xs mb-4">
              {purchase.supplierName ?? "Sem fornecedor"}
              {purchase.invoiceNumber ? ` · ${purchase.invoiceNumber}` : ""}
              {purchase.issuedOn ? ` · ${purchase.issuedOn}` : ""}
            </div>
            <div className="space-y-2 mb-4">
              {purchase.items.map((i) => (
                <div key={i.id} className="bg-stone-800/60 rounded-xl px-3 py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{i.productName}</div>
                    <div className="text-stone-500 text-[11px]">
                      {i.quantity} un × {formatBRL(i.unitCost)}
                      {i.batchNo ? ` · lote ${i.batchNo}` : ""}
                      {purchase.averages?.[i.productId] != null ? ` · médio atual ${formatBRL(purchase.averages[i.productId])}` : ""}
                    </div>
                  </div>
                  <span className="text-sm font-bold shrink-0">{formatBRL(i.lineTotal)}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t border-stone-800 pt-3">
              <span className="text-stone-400 text-sm">Total</span>
              <span className="font-display font-bold text-lg">{formatBRL(purchase.total)}</span>
            </div>
            {purchase.note && <div className="text-stone-500 text-xs mt-2">{purchase.note}</div>}
          </>
        )}
      </div>
    </Modal>
  );
}

// Aba Compras (gerente, só com purchase_enabled): histórico de documentos de
// compra, cadastro de fornecedores e registro de novas entradas no ledger.
export default function PurchaseTab({ showToast }) {
  const { session } = useAuth();
  const [purchases, setPurchases] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [showSupplierCreate, setShowSupplierCreate] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s, st] = await Promise.all([
        listPurchases({ limit: 50 }),
        listSuppliers(),
        listStock({ limit: 200 }),
      ]);
      setPurchases(p.data);
      setSuppliers(s.data);
      setProducts(st.data);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime: compras vindas de outra tela atualizam o histórico.
  const handleEvent = useCallback(
    (msg) => {
      if (msg.type === "purchase.received" || msg.type === "stock.movement") load();
    },
    [load]
  );
  useRealtime(session?.token, ["inventory"], handleEvent);

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display font-bold text-lg">Compras</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSuppliers(true)}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold border border-stone-800 bg-stone-900 text-stone-300"
          >
            <Truck size={14} /> Fornecedores
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-amber-500 text-stone-950"
          >
            <PackagePlus size={14} /> Nova compra
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-stone-600 text-center py-12 text-sm">Carregando…</div>
      ) : (
        <div className="space-y-2">
          {purchases.map((p) => (
            <button
              key={p.id}
              onClick={() => setDetailId(p.id)}
              className="w-full text-left flex items-center justify-between gap-3 bg-stone-900 border border-stone-800 rounded-xl px-3 py-2.5 hover:border-stone-700 transition-colors"
            >
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">
                  {p.supplierName ?? "Sem fornecedor"}
                  {p.invoiceNumber ? <span className="text-stone-500 font-normal"> · {p.invoiceNumber}</span> : ""}
                </div>
                <div className="text-stone-500 text-xs">
                  {p.issuedOn ?? formatDateTime(p.createdAt)} · {p.createdByName}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-display font-bold">{formatBRL(p.total)}</span>
                <ChevronRight size={15} className="text-stone-600" />
              </div>
            </button>
          ))}
          {purchases.length === 0 && (
            <div className="text-stone-600 text-center py-16">
              <PackagePlus size={32} className="mx-auto mb-2 opacity-50" />
              <div className="text-sm">Nenhuma compra registrada.</div>
              <div className="text-xs mt-1">Registre entradas de mercadoria para atualizar o estoque e o custo médio.</div>
            </div>
          )}
        </div>
      )}

      {showNew && (
        <NewPurchaseModal
          suppliers={suppliers.filter((s) => s.active)}
          products={products}
          onClose={() => setShowNew(false)}
          onSaved={async () => {
            setShowNew(false);
            await load();
          }}
          showToast={showToast}
        />
      )}
      {showSuppliers && (
        <SuppliersList
          suppliers={suppliers}
          onChanged={load}
          onOpenCreate={() => setShowSupplierCreate(true)}
          onClose={() => setShowSuppliers(false)}
          showToast={showToast}
        />
      )}
      {showSupplierCreate && (
        <SupplierModal
          onClose={() => setShowSupplierCreate(false)}
          onSaved={async () => {
            setShowSupplierCreate(false);
            await load();
          }}
          showToast={showToast}
        />
      )}
      {detailId && <PurchaseDetail purchaseId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

import { listStockMovements } from "@/entities/stock";
import { Modal } from "@/shared/components";
import { formatDateTime } from "@/shared/lib";
import { ArrowDownCircle, ArrowUpCircle, RotateCcw, Scale } from "lucide-react";
import React, { useState, useEffect } from "react";

const TYPE_META = {
  sale: { label: "Venda", icon: ArrowDownCircle, color: "text-destructive" },
  refund: { label: "Estorno", icon: RotateCcw, color: "text-channel-sky" },
  purchase: { label: "Compra", icon: ArrowUpCircle, color: "text-success" },
  adjustment: { label: "Ajuste", icon: Scale, color: "text-primary" },
};

// Histórico do ledger (fonte da verdade do estoque): cada linha soma no
// saldo; venda/estorno vêm do fluxo de comandas, compra/ajuste do gerente.
export default function MovementsList({ productId, productName, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listStockMovements(productId ? { product_id: productId, limit: 100 } : { limit: 100 })
      .then((r) => setRows(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [productId]);

  return (
    <Modal title="Movimentos" subtitle={productName} onClose={onClose}>
      <div className="p-5">
        {loading ? (
          <div className="text-text-muted text-center py-10 text-sm">Carregando…</div>
        ) : (
          <div className="space-y-2">
            {rows.map((m) => {
              const meta = TYPE_META[m.type] ?? TYPE_META.adjustment;
              const Icon = meta.icon;
              return (
                <div
                  key={m.id}
                  className="bg-surface-overlay/60 rounded-xl px-3 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex items-center gap-2.5">
                    <Icon size={16} className={`shrink-0 ${meta.color}`} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">
                        {meta.label}
                        <span className="text-text-muted font-normal">
                          {" "}
                          · {productName ? "" : m.productName}
                        </span>
                      </div>
                      <div className="text-text-muted text-[11px] truncate">
                        {formatDateTime(m.createdAt)} · {m.userName}
                        {m.note ? ` · ${m.note}` : ""}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`text-sm font-bold shrink-0 ${m.quantityDelta > 0 ? "text-success" : "text-destructive"}`}
                  >
                    {m.quantityDelta > 0 ? "+" : ""}
                    {m.quantityDelta}
                  </span>
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="text-text-muted text-center py-10 text-sm">
                Nenhum movimento registrado.
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

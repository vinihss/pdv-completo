import React, { useState, useEffect } from "react";
import { auditLog } from "@/shared/api/reports";

const ACTION_LABEL = {
  order_opened: "Comanda aberta",
  item_added: "Item lançado",
  item_removed: "Item removido",
  item_ready: "Item marcado pronto",
  item_delivered: "Item entregue",
  payment_registered: "Pagamento registrado",
  order_closed: "Comanda fechada",
  product_created: "Produto criado",
  product_updated: "Produto atualizado",
  product_activated: "Produto ativado",
  product_deactivated: "Produto desativado",
  product_image_changed: "Foto do produto alterada",
  product_image_removed: "Foto do produto removida",
  category_created: "Categoria criada",
  category_updated: "Categoria atualizada",
  category_deleted: "Categoria excluída",
  kitchen_group_created: "Grupo de produção criado",
  kitchen_group_updated: "Grupo de produção atualizado",
  kitchen_group_deleted: "Grupo de produção excluído",
};

export default function AuditTab() {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    auditLog({ limit: 100 }).then((r) => setLogs(r.data));
  }, []);
  return (
    <div className="p-5 max-w-2xl mx-auto space-y-2">
      {logs.map((l) => (
        <div key={l.id} className="flex items-center justify-between bg-stone-900 border border-stone-800 rounded-xl px-4 py-2.5 text-sm">
          <div>
            <div className="font-medium">{ACTION_LABEL[l.action] ?? l.action}</div>
            <div className="text-stone-500 text-xs">{l.userName} · {l.createdAt}</div>
          </div>
        </div>
      ))}
      {logs.length === 0 && <div className="text-stone-600 text-center py-10">Sem eventos registrados.</div>}
    </div>
  );
}
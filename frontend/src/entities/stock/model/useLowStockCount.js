import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { listStock } from "../api/stock.js";

/**
 * Quantos produtos estão no estoque mínimo — o badge do item "Estoque" no
 * menu do gerente. `GET /stock` é `requireRole("manager")` no backend, então
 * fora do gerente o contador fica em 0 e nenhuma chamada é feita (também
 * porque o módulo só liga com `inventory_enabled`).
 *
 * Vive na entity (e não na página) porque o badge é desenhado pela casca do
 * app (`widgets/app-menu`), que é irmã da página — mesmo padrão do
 * `useDeliveries`.
 */
export function useLowStockCount() {
  const { session, storeSettings } = useAuth();
  const [count, setCount] = useState(0);
  const enabled = (storeSettings?.inventoryEnabled ?? false) && session?.user?.role === "manager";

  const refresh = useCallback(() => {
    if (!enabled) return;
    // Resumo barato: 1 chamada com low_only, e o total vem no cabeçalho.
    listStock({ low_only: "true", limit: 1 })
      .then((r) => setCount(r.total ?? 0))
      .catch(() => {});
  }, [enabled]);

  useEffect(() => {
    setCount(0);
    refresh();
  }, [refresh]);

  // Ao vivo: qualquer movimento de estoque em qualquer tela (room "inventory").
  useRealtime(
    session?.token,
    enabled ? ["inventory"] : [],
    (msg) => {
      if (msg.type === "stock.movement" || msg.type === "stock.low") refresh();
    },
    refresh
  );

  return count;
}

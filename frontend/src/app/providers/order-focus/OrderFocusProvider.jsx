import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useNav } from "@/app/providers/nav";

/**
 * "Abrir esta comanda" pedido por quem NÃO é a página de comandas — hoje só
 * pelo sino do header.
 *
 * Existe porque o sino é desenhado pela casca (`app/router.jsx`) e as comandas
 * são desenhadas pela página (`widgets/order-board`), que são **irmãs** na
 * árvore: não há prop que atravesse. Mesmo problema (e mesma solução) do
 * `NavProvider`, que guarda a tela ativa do gerente.
 *
 * `focusOrder(id)` faz duas coisas, e as duas importam:
 *  1. `setActiveId("orders")` — o gerente pode estar em Catálogo/Estoque; sem
 *     trocar a tela, a comanda abriria "atrás" do menu. Para o garçom o id é o
 *     mesmo da tela, então é no-op.
 *  2. guarda o id focado, que o `OrderBoard` lê e consome (abre a comanda e
 *     marca o alerta como lido).
 *
 * O consume é "esgote e limpe": o `OrderBoard` chama `clearFocus()` ao abrir,
 * senão o id fica preso e o próximo F5 abriria a comanda sozinha.
 */
const OrderFocusContext = createContext(null);

export function OrderFocusProvider({ children }) {
  const { setActiveId } = useNav();
  const [focusedOrderId, setFocusedOrderId] = useState(null);

  const focusOrder = useCallback(
    (orderId) => {
      if (!orderId) return;
      setActiveId("orders");
      setFocusedOrderId(orderId);
    },
    [setActiveId]
  );

  const clearFocus = useCallback(() => setFocusedOrderId(null), []);

  const value = useMemo(
    () => ({ focusedOrderId, focusOrder, clearFocus }),
    [focusedOrderId, focusOrder, clearFocus]
  );

  return <OrderFocusContext.Provider value={value}>{children}</OrderFocusContext.Provider>;
}

export function useOrderFocus() {
  const ctx = useContext(OrderFocusContext);
  if (!ctx) throw new Error("useOrderFocus precisa estar dentro de <OrderFocusProvider>");
  return ctx;
}

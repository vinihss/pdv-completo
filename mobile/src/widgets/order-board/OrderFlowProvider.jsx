// Estado do fluxo de comandas do garçom: a lista (useOrders) + o "foco" que o
// sino pede. Porta do OrderFocusProvider do web — aqui numa fronteira menor
// porque o fluxo nativo vive dentro do GarconFlowStub (root do app), e o
// sino é irmão da lista, da mesma forma que no router web.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { openOrder } from "@/entities/order";
import { useOrders } from "./useOrders.js";

const OrderFlowContext = createContext(null);

export function OrderFlowProvider({ children }) {
  const { orders, loading, error, reloadAll, reloadOne, setOrders } = useOrders();
  const [focusedOrderId, setFocusedOrderId] = useState(null);

  const focusOrder = useCallback((orderId) => {
    if (!orderId) return;
    setFocusedOrderId(orderId);
  }, []);

  const clearFocus = useCallback(() => setFocusedOrderId(null), []);

  const createOrder = useCallback(
    async (identification) => {
      const order = await openOrder(identification);
      setOrders((prev) => [order, ...prev]);
      return order;
    },
    [setOrders]
  );

  const value = useMemo(
    () => ({
      orders,
      loading,
      error,
      reloadAll,
      reloadOne,
      focusedOrderId,
      focusOrder,
      clearFocus,
      createOrder,
    }),
    [orders, loading, error, reloadAll, reloadOne, focusedOrderId, focusOrder, clearFocus, createOrder]
  );

  return <OrderFlowContext.Provider value={value}>{children}</OrderFlowContext.Provider>;
}

export function useOrderFlow() {
  const ctx = useContext(OrderFlowContext);
  if (!ctx) throw new Error("useOrderFlow precisa estar dentro de <OrderFlowProvider>");
  return ctx;
}
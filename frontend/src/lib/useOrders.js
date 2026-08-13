import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useRealtime } from "../lib/ws.js";

/**
 * Fonte única de verdade das comandas abertas pra garçom/gerente: busca via
 * REST no mount e mantém sincronizado por WebSocket (evita polling). Em caso
 * de qualquer evento relevante, recarrega a comanda afetada (mais simples e
 * robusto do que tentar aplicar patches otimistas em cada tipo de evento).
 */
export function useOrders() {
  const { session } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const ordersRef = useRef(orders);
  ordersRef.current = orders;

  const reloadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [openRes, closedRes] = await Promise.all([
        api.listOrders("open"),
        api.listOrders("closed", 200),
      ]);
      setOrders([...openRes.data, ...closedRes.data]);
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadOne = useCallback(async (orderId) => {
    try {
      const order = await api.getOrder(orderId);
      setOrders((prev) => {
        if (order.status === "closed") return prev.filter((o) => o.id !== orderId);
        const exists = prev.some((o) => o.id === orderId);
        return exists ? prev.map((o) => (o.id === orderId ? order : o)) : [order, ...prev];
      });
      return order;
    } catch {
      // comanda pode ter sido removida — ignora
      return null;
    }
  }, []);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  const handleEvent = useCallback(
    (msg) => {
      if (msg.payload?.orderId) reloadOne(msg.payload.orderId);
    },
    [reloadOne]
  );

  const rooms = session ? [`waiter:${session.user.id}`, "kitchen-display"] : [];
  useRealtime(session?.token, rooms, handleEvent);

  return { orders, loading, reloadAll, reloadOne, setOrders };
}

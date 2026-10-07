// Fonte única de verdade das comandas do garçom — portado de
// frontend/src/widgets/order-board/useOrders.js. Busca via REST no mount e
// mantém sincronizado por WebSocket (evita polling). Em caso de qualquer
// evento relevante, recarrega a comanda afetada; ao reconectar OU voltar do
// background, recarrega tudo (não há buffer de eventos perdidos no backend).

import { useState, useEffect, useCallback, useRef } from "react";
import { listOrders, getOrder } from "@/entities/order";
import { useAuth } from "@/app/providers/auth";
import { useRealtime, useAppStateActive } from "@/shared/hooks";

export function useOrders() {
  const { session } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  // Falha do GET inicial/recarga: sem isto o `Promise.all` rejeitava sem dono
  // (unhandled rejection) e a lista mostrava "vazio" como se não houvesse comanda.
  const [error, setError] = useState(null);
  const ordersRef = useRef(orders);
  ordersRef.current = orders;

  const reloadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [openRes, closedRes] = await Promise.all([
        listOrders("open"),
        listOrders("closed", 200),
      ]);
      setOrders([...openRes.data, ...closedRes.data]);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadOne = useCallback(async (orderId) => {
    try {
      const order = await getOrder(orderId);
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

  // Voltar do background é o substituto RN do `visibilitychange` do web.
  useAppStateActive(reloadAll);

  const handleEvent = useCallback(
    (msg) => {
      if (msg.payload?.orderId) reloadOne(msg.payload.orderId);
    },
    [reloadOne]
  );

  const rooms = session ? [`waiter:${session.user.id}`, "kitchen-display"] : [];
  useRealtime(session?.token, rooms, handleEvent, reloadAll);

  return { orders, loading, error, reloadAll, reloadOne, setOrders };
}
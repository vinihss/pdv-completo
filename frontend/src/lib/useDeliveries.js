import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useRealtime } from "../lib/ws.js";

/**
 * Fonte única de verdade das entregas pro painel do manager — mesmo padrão
 * de useOrders.js: busca via REST no mount, recarrega tudo em qualquer
 * evento da room "deliveries" (mais simples que aplicar patch por tipo de
 * evento, e o volume de entregas simultâneas não justifica otimizar isso).
 */
export function useDeliveries() {
  const { session } = useAuth();
  const [deliveries, setDeliveries] = useState([]);
  const [couriers, setCouriers] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [deliveriesRes, couriersRes] = await Promise.all([api.listDeliveries(), api.listCouriers()]);
      setDeliveries(deliveriesRes);
      setCouriers(couriersRes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const rooms = session ? ["deliveries"] : [];
  useRealtime(session?.token, rooms, reload);

  return { deliveries, couriers, loading, reload };
}

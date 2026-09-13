import { useState, useEffect, useCallback } from "react";
import { api } from "./api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useRealtime } from "./ws.js";

/**
 * O backend já filtra por courierId = usuário autenticado (ver
 * listCourierDeliveriesUsecase em delivery.usecases.ts) — o entregador nunca
 * vê entrega de outro, então não precisa filtrar de novo aqui.
 */
export function useCourierDeliveries() {
  const { session } = useAuth();
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setDeliveries(await api.listMyDeliveries());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const rooms = session ? ["deliveries"] : [];
  useRealtime(session?.token, rooms, reload);

  return { deliveries, loading, reload };
}

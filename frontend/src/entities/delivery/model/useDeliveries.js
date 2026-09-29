import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { listCouriers, listDeliveries, listMyDeliveries } from "../api/delivery.js";

/**
 * Fonte única das entregas. O mesmo agregado (entrega) é visto por dois
 * papéis, então o hook é o mesmo — muda só o escopo do backend:
 *
 *   scope="manager" → GET /deliveries + GET /delivery/couriers
 *   scope="courier" → GET /deliveries/mine (o backend já filtra por
 *                     courierId = usuário autenticado, ver
 *                     listCourierDeliveriesUsecase; o entregador nunca vê
 *                     entrega de outro, então não refiltramos aqui)
 *
 * Mesmo padrão de useOrders: busca via REST no mount e recarrega tudo em
 * qualquer evento da room "deliveries" (mais simples que aplicar patch por
 * tipo de evento, e o volume de entregas simultâneas não justifica otimizar).
 */
export function useDeliveries(scope = "manager") {
  const { session } = useAuth();
  const [deliveries, setDeliveries] = useState([]);
  const [couriers, setCouriers] = useState([]);
  const [loading, setLoading] = useState(true);

  const isCourier = scope === "courier";

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      if (isCourier) {
        setDeliveries(await listMyDeliveries());
      } else {
        const [deliveriesRes, couriersRes] = await Promise.all([listDeliveries(), listCouriers()]);
        setDeliveries(deliveriesRes);
        setCouriers(couriersRes);
      }
    } finally {
      setLoading(false);
    }
  }, [isCourier]);

  useEffect(() => {
    reload();
  }, [reload]);

  const rooms = session ? ["deliveries"] : [];
  useRealtime(session?.token, rooms, reload, reload);

  return { deliveries, couriers, loading, reload };
}

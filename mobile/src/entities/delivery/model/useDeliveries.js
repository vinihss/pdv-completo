// Portado de frontend/src/entities/delivery/model/useDeliveries.js.
// Diferenças RN: o recarregamento ao "voltar para a aba" (visibilitychange)
// virou `useAppStateActive` (voltar do background). O resto é igual.

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/app/providers/auth";
import { useAppStateActive, useRealtime } from "@/shared/hooks";
import { listCouriers, listDeliveries, listMyDeliveries } from "../api/delivery.js";

/**
 * Status que não são "a fazer": entregue (já foi) e cancelado (deixou de
 * ser pedido). Nenhuma das duas pertence à lista de trabalho — nem do
 * entregador nem do balcão — e as duas somem da tela por padrão.
 */
const RESOLVED_STATUSES = new Set(["delivered", "cancelled"]);

/**
 * A entrega ainda pede ação?
 */
export function isOpenDelivery(delivery) {
  return !RESOLVED_STATUSES.has(delivery?.status);
}

/**
 * Fonte única das entregas. O mesmo agregado (entrega) é visto por dois
 * papéis, então o hook é o mesmo — muda só o escopo do backend:
 *
 *   scope="manager" → GET /deliveries + GET /delivery/couriers
 *   scope="courier" → GET /deliveries/mine (o backend já filtra por
 *                     courierId = usuário autenticado; o entregador nunca vê
 *                     entrega de outro, então não refiltramos aqui)
 *
 * Busca via REST no mount e recarrega tudo em qualquer evento da room
 * "deliveries". `error` saiu junto com o `catch`: sem ele, uma falha de rede
 * viraria "Nenhuma entrega pendente no momento" — indistinguível de "não tem
 * entrega nenhuma".
 */
export function useDeliveries(scope = "manager", { pollMs = 0 } = {}) {
  const { session } = useAuth();
  const [deliveries, setDeliveries] = useState([]);
  const [couriers, setCouriers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
      // Sucesso limpa o erro: a tela "voltou" e o aviso some sozinho.
      setError(null);
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      setError(failure);
      console.error("falha ao carregar entregas:", failure);
    } finally {
      setLoading(false);
    }
  }, [isCourier]);

  useEffect(() => {
    reload();
  }, [reload]);

  // O WS não tem buffer de eventos perdidos. Voltar do background é o
  // momento em que se descobre que um evento se foi: o mesmo substituto do
  // AlertsProvider, mesmo padrão (no web: `visibilitychange`).
  useAppStateActive(() => {
    if (session) reload();
  });

  // Polling de backup, DESLIGADO por padrão (`pollMs = 0`). Quem quiser a
  // garantia de consistência sem depender do retorno do app passa
  // `{ pollMs: 4000 }`. O timer é sempre limpo no unmount.
  useEffect(() => {
    if (!pollMs || pollMs <= 0) return;
    const timer = setInterval(() => {
      reload();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, reload]);

  const rooms = session ? ["deliveries"] : [];
  useRealtime(session?.token, rooms, reload, reload);

  return { deliveries, couriers, loading, error, reload };
}
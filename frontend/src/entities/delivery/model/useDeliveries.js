import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { listCouriers, listDeliveries, listMyDeliveries } from "../api/delivery.js";

/**
 * Status que não são "a fazer": entregue (já foi) e cancelado (deixou de
 * ser pedido). Nenhuma das duas pertence à lista de trabalho — nem do
 * entregador nem do balcão — e as duas somem da tela por padrão.
 */
const RESOLVED_STATUSES = new Set(["delivered", "cancelled"]);

/**
 * A entrega ainda pede ação?
 *
 * Filtro no cliente, e não na query: a lista já é curta (as entregas do dia) e
 * o realtime recarrega tudo de qualquer evento, então filtrar na hora da
 * renderização evita o caso chato de "marquei como entregue, a tela não
 * mudou, dei F5". No servidor o filtro só importaria para uma operação muito
 * maior do que a de um restaurante.
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
 *                     courierId = usuário autenticado, ver
 *                     listCourierDeliveriesUsecase; o entregador nunca vê
 *                     entrega de outro, então não refiltramos aqui)
 *
 * Mesmo padrão de useOrders: busca via REST no mount e recarrega tudo em
 * qualquer evento da room "deliveries" (mais simples que aplicar patch por
 * tipo de evento, e o volume de entregas simultâneas não justifica otimizar).
 *
 * `error` saiu junto com o `catch`: sem ele, uma falha de rede virava
 * "Nenhuma entrega pendente no momento" — indistinguível de "não tem
 * entrega nenhuma", que é a leitura errada e a que mais custa (o entregador
 * conclui que está livre para encerrar o expediente). A assinatura segue
 * retrocompatível (`{ deliveries, couriers, loading, reload }` + `error`).
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

  // O WS não tem buffer de eventos perdidos (docs/05 §realtime: "o cliente
  // trata o WS como otimização, o polling é o garantidor de consistência" — o
  // dispatcher do outbox marca a publicação como feita mesmo sem assinante).
  // Voltar o foco da aba é o momento em que se descobre que o evento se foi:
  // é o mesmo substituto barato do AlertsProvider, mesmo padrão.
  useEffect(() => {
    if (!session || typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [session, reload]);

  // Polling de backup, DESLIGADO por padrão (`pollMs = 0`). A tela tem realtime
  // e o recarregamento no foco da aba; um GET a cada 4s em cada tablet do
  // salão é tráfego que ninguém pediu. Quem quiser a garantia de consistência
  // sem depender do foco da aba (uma tela de delivery que fica o dia inteiro
  // aberta no fundo, sem o usuário tocar) passa `{ pollMs: 4000 }`. O timer é
  // sempre limpo no unmount — nada de GET zumbindo em tela fechada.
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

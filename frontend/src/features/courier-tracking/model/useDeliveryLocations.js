import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@/shared/hooks";
import { listDeliveryLocations } from "../api/tracking.js";

// Mesma chave do AuthProvider — lida direto, e não via `useAuth`, de
// propósito: a aba de Entregas do gerente é testada sem `<AuthProvider>` e
// o hook não pode derrubar a tela inteira por causa do mapa. O token só
// interessa para o WebSocket; o GET usa o token global do `http.js`.
function readToken() {
  try {
    return JSON.parse(sessionStorage.getItem("pdv:session"))?.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Posições dos entregadores em rota, para o mapa de acompanhamento do
 * gerente.
 *
 * Carga inicial via `GET /manager/deliveries/locations`; daí em diante o
 * evento realtime `courier.location` (room `deliveries`, que o gerente já
 * assina) aplica patch por `courierId` — um GET por ping de GPS de cada
 * entregador seria tráfego de graça, e o evento já carrega tudo que o
 * marker precisa. No `onReconnect` recarrega tudo: o outbox não faz buffer
 * de eventos perdidos, então a janela de queda se recupera por REST.
 *
 * `loaded` distingue "ainda buscando" de "buscou e não veio ninguém" — o
 * estado vazio ("Sem localização do entregador ainda") só é honesto depois
 * da primeira resposta.
 */
export function useDeliveryLocations() {
  const [locations, setLocations] = useState([]); // [{ courierId, courierName, latitude, longitude, updatedAt }]
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await listDeliveryLocations();
      setLocations(Array.isArray(res) ? res : []);
    } catch {
      // Silencioso de propósito: o mapa é um complemento da aba, não o
      // trabalho dela — a lista de entregas (que já tem o próprio erro)
      // é que não pode ficar refém do GPS.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onEvent = useCallback((msg) => {
    if (msg?.type !== "courier.location" || !msg.payload) return;
    const { courierId, courierName, latitude, longitude, updatedAt } = msg.payload;
    if (!courierId || latitude == null || longitude == null) return;
    setLocations((prev) => {
      const next = { courierId, courierName, latitude, longitude, updatedAt };
      const idx = prev.findIndex((l) => l.courierId === courierId);
      if (idx === -1) return [...prev, next];
      const copy = [...prev];
      // Nome chega só na carga inicial (o evento não repete) — preserva o
      // que já se tinha quando o payload não traz.
      copy[idx] = { ...copy[idx], ...next, courierName: courierName ?? copy[idx].courierName };
      return copy;
    });
  }, []);

  useRealtime(readToken(), ["deliveries"], onEvent, reload);

  return { locations, loaded, reload };
}

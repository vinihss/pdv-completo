import { useEffect, useRef, useCallback } from "react";
import { wsEndpoint } from "@/shared/lib";

/**
 * Espelha useRealtime pra cliente anônimo (tela de confirmação do /pedido):
 * conecta em /realtime/public — sem JWT, o backend só permite entrar em
 * rooms `order:<orderId>` (o UUID é a "senha" de fato, mesmo modelo de
 * confiança do GET /public/orders/:id/status). Entra nas rooms informadas
 * e chama `onEvent` pra cada mensagem. Reconecta automaticamente com
 * backoff simples; ao reconectar, o caller deve recarregar o estado via
 * GET (o backend não faz buffer de eventos perdidos).
 */
export function usePublicRealtime(rooms, onEvent) {
  const wsRef = useRef(null);
  const attemptRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const roomsKey = JSON.stringify(rooms ?? []);

  const connect = useCallback(() => {
    // No web cai no host atual; no desktop, na origem configurada.
    const ws = new WebSocket(wsEndpoint("/realtime/public"));
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      for (const room of rooms ?? []) {
        ws.send(JSON.stringify({ type: "join", room }));
      }
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        onEventRef.current?.(msg);
      } catch {
        // ignora mensagem malformada
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return; // já foi substituído por um novo connect()
      const delay = Math.min(1000 * 2 ** attemptRef.current, 10000);
      attemptRef.current += 1;
      setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);
}

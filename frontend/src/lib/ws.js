import { useEffect, useRef, useCallback } from "react";

/**
 * Conecta em /realtime, entra nas rooms informadas e chama `onEvent` pra
 * cada mensagem recebida. Reconecta automaticamente com backoff simples.
 * Ao reconectar, o caller deve recarregar o estado atual via GET (o backend
 * ainda não faz buffer de eventos perdidos — ver nota em realtime.routes.ts).
 */
export function useRealtime(token, rooms, onEvent) {
  const wsRef = useRef(null);
  const attemptRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const roomsKey = JSON.stringify(rooms ?? []);

  const connect = useCallback(() => {
    if (!token) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/realtime?token=${token}`);
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
  }, [token, roomsKey]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);
}

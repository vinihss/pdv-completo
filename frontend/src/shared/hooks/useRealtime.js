import { useEffect, useRef, useCallback } from "react";

/**
 * Conecta em /realtime, entra nas rooms informadas e chama `onEvent` pra
 * cada mensagem recebida. Reconecta automaticamente com backoff simples.
 *
 * `onReconnect` (opcional) é chamado a cada **(re)abertura depois da
 * primeira**: o backend ainda não faz buffer de eventos perdidos — o
 * dispatcher do outbox marca o evento como publicado mesmo quando a sala não
 * tem nenhum assinante (ver `pollOutboxOnce`), então quem caiu durante o
 * evento não vai recebê-lo de volta. Quem depende de evento para não perder
 * estado (sino de alertas, listas de comanda) precisa recarregar por GET
 * quando isso acontece.
 */
export function useRealtime(token, rooms, onEvent, onReconnect) {
  const wsRef = useRef(null);
  const attemptRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  // A primeira abertura é a montagem normal: quem chama já carregou por GET,
  // e disparar o callback aqui viraria um refetch duplicado em todo login.
  const hasOpenedRef = useRef(false);

  const roomsKey = JSON.stringify(rooms ?? []);

  const connect = useCallback(() => {
    if (!token) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    // 2.3 — token via subprotocol (Sec-WebSocket-Protocol), não na query string
    // (que vazaria nos logs do proxy/Caddy). O server reflete o protocolo no
    // handshake; se o token for inválido, a conexão é fechada com 4001.
    const ws = new WebSocket(`${proto}//${window.location.host}/realtime`, [token]);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      for (const room of rooms ?? []) {
        ws.send(JSON.stringify({ type: "join", room }));
      }
      if (hasOpenedRef.current) onReconnectRef.current?.();
      hasOpenedRef.current = true;
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

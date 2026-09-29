import { useEffect, useRef, useCallback } from "react";
import { wsEndpoint } from "@/shared/lib";

/**
 * Conecta em /realtime, entra nas rooms informadas e chama `onEvent` pra
 * cada mensagem recebida. `onResync` é chamado a cada abertura bem-sucedida
 * e é o gancho para recarregar o estado via GET.
 *
 * Por que `onResync` dispara em TODO `onopen` (e não só na reconexão): num
 * deploy sem downtime as duas instâncias do backend coexistem e o `WsGateway`
 * é local a cada processo — um evento publicado pela instância A não chega
 * num cliente que acabou de abrir socket na instância B. "Socket aberto ⇒
 * estado conferido" é a regra que fecha esse buraco sem leader lock (ver
 * § Deploy sem downtime no deploy/README.md). O custo é um GET a mais na
 * montagem, que a tela já faz. O backend ainda não faz buffer de eventos
 * perdidos (`sync.request` responde vazio — ver realtime.routes.ts), então
 * recarregar é a única forma de não ficar com dado velho.
 */
export function useRealtime(token, rooms, onEvent, onResync) {
  const wsRef = useRef(null);
  const attemptRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;

  const roomsKey = JSON.stringify(rooms ?? []);

  const connect = useCallback(() => {
    if (!token) return;
    // No web cai no host atual; no desktop, na origem configurada (ver
    // shared/lib/appConfig.js — a API pode estar em outra máquina).
    // 2.3 — token via subprotocol (Sec-WebSocket-Protocol), não na query string
    // (que vazaria nos logs do proxy/Caddy). O server reflete o protocolo no
    // handshake; se o token for inválido, a conexão é fechada com 4001.
    const ws = new WebSocket(wsEndpoint("/realtime"), [token]);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      for (const room of rooms ?? []) {
        ws.send(JSON.stringify({ type: "join", room }));
      }
      // Estado conferido por REST: cobre reconexão, primeiro socket e o
      // cliente que caiu na instância nova durante o drain de um deploy.
      onResyncRef.current?.();
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
      // Backoff exponencial COM jitter ("equal jitter"): a queda é de
      // segundos, então o primeiro retry é ~125-250ms — esperar 1s fixo era
      // o que dava a impressão de tela travada. Teto de 10s.
      const base = Math.min(250 * 2 ** attemptRef.current, 10000);
      attemptRef.current += 1;
      const delay = base / 2 + Math.random() * (base / 2);
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

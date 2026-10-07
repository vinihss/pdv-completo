// Portado de frontend/src/shared/hooks/useRealtime.js (o contrato é o MESMO —
// ver o comentário do arquivo web para o porquê de cada regra).
// Diferenças RN:
//   - o WebSocket nativo aceita o token como subprotocol igual ao browser
//     (`new WebSocket(url, [token])`; servidor fecha 4001 se inválido);
//   - sem servidor configurado (sem config/URL absoluta) não abre socket:
//     a tela de setup bloqueia o app, então não há o que reconectar. O guard
//     abaixo evita `new WebSocket("/realtime")` (URL inválida no RN).

import { useEffect, useRef, useCallback } from "react";
import { wsEndpoint } from "@/shared/lib";

/**
 * Conecta em /realtime, entra nas rooms informadas e chama `onEvent` pra
 * cada mensagem recebida. Reconecta automaticamente com backoff exponencial
 * com jitter.
 *
 * `onReconnect` (opcional) é chamado a cada **(re)abertura depois da
 * primeira**: o backend ainda não faz buffer de eventos perdidos — o
 * dispatcher do outbox marca o evento como publicado mesmo quando a sala não
 * tem nenhum assinante — então quem caiu durante o evento não vai recebê-lo
 * de volta. Quem depende de evento para não perder estado (sino de alertas,
 * listas de comanda, entregas) precisa recarregar por GET quando isso
 * acontece.
 *
 * A primeira abertura é a montagem normal: quem chama já carregou por GET, e
 * disparar o callback ali viraria um refetch duplicado a cada login.
 */
export function useRealtime(token, rooms, onEvent, onReconnect) {
  const wsRef = useRef(null);
  const attemptRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  const hasOpenedRef = useRef(false);

  const roomsKey = JSON.stringify(rooms ?? []);

  const connect = useCallback(() => {
    if (!token) return;
    const url = wsEndpoint("/realtime");
    // Sem servidor configurado o endpoint é o path puro ("/realtime"), que o
    // WebSocket nativo recusa como URL. Não tem o que fazer fora da tela de
    // setup — apenas não conectar.
    if (!/^wss?:\/\//i.test(url)) return;
    const ws = new WebSocket(url, [token]);
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
      // Backoff exponencial COM jitter ("equal jitter"), começando em ~125ms
      // (teto de 10s): a queda costuma durar segundos, e esperar 1s fixo era o
      // que dava a impressão de tela travada. O jitter evita que um lote de
      // reconexões bata no servidor no mesmo instante.
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
  }, [connect]);
}
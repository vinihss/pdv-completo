import { useEffect, useRef, useState, useCallback } from "react";

const WS_URL = "ws://localhost:8765";
const RECONNECT_DELAY = 3000;

export function useMenuForma() {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws;
    let closed = false;
    let timer;

    function connect() {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "ping" }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "pong") {
          setConnected(true);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, RECONNECT_DELAY);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  const print = useCallback((data) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      throw new Error("Print Agent não está conectado");
    }
    wsRef.current.send(JSON.stringify({ type: "print", printer: "auto", data }));
  }, []);

  return { connected, print };
}

export function isPrintAgentAvailable() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 1000);
    ws.onopen = () => {
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

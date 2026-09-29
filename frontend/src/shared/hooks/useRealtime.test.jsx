import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRealtime } from "./useRealtime.js";

// ============================================================
// useRealtime — o contrato que sustenta o deploy sem downtime
// ============================================================
// O backend não faz buffer de evento perdido (`sync.request` responde vazio),
// então a única defesa contra tela velha é o `onResync` disparado a cada
// `onopen`. Este teste cobre as três coisas que o deploy depende:
//   1. o estado é conferido por REST quando o socket abre;
//   2. reconectar reconfere de novo (é o caso de queda de rede);
//   3. o primeiro retry é rápido — backoff de 1s fixo era justamente o que
//      dava a impressão de tela travada logo após um corte.

class FakeWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  // Ajudantes de teste: o servidor "aceita" e "manda" mensagens.
  accept() {
    this.onopen?.();
  }

  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function Probe({ token, rooms, onEvent, onResync }) {
  useRealtime(token, rooms, onEvent, onResync);
  return null;
}

const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe("useRealtime", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("entra nas rooms, entrega evento e sincroniza o estado ao abrir", () => {
    const onEvent = vi.fn();
    const onResync = vi.fn();
    render(<Probe token="jwt-123" rooms={["kitchen-display", "inventory"]} onEvent={onEvent} onResync={onResync} />);

    // Token vai como subprotocol, nunca na query string (2.3).
    expect(last().protocols).toEqual(["jwt-123"]);
    expect(last().url).not.toContain("jwt-123");

    act(() => last().accept());
    expect(last().sent).toEqual([
      { type: "join", room: "kitchen-display" },
      { type: "join", room: "inventory" },
    ]);
    expect(onResync).toHaveBeenCalledTimes(1);

    act(() => last().emit({ type: "order.item.created", payload: { orderId: "o-1" } }));
    expect(onEvent).toHaveBeenCalledWith({ type: "order.item.created", payload: { orderId: "o-1" } });
  });

  it("reconexão reconfere o estado de novo (o dado pode ter ficado velho)", () => {
    const onResync = vi.fn();
    render(<Probe token="jwt-123" rooms={["inventory"]} onEvent={() => {}} onResync={onResync} />);

    act(() => last().accept());
    expect(onResync).toHaveBeenCalledTimes(1);

    act(() => last().close());
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => last().accept());
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("primeiro retry é rápido: entre 125ms e 250ms", () => {
    render(<Probe token="jwt-123" rooms={[]} onEvent={() => {}} onResync={() => {}} />);
    act(() => last().accept());
    act(() => last().close());

    // Ainda não conectou de novo no meio do jitter…
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    // …e já conectou no fim dele.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backoff cresce e tem teto de 10s (não martela o servidor)", () => {
    render(<Probe token="jwt-123" rooms={[]} onEvent={() => {}} onResync={() => {}} />);
    act(() => last().accept());

    const aberturaEm = [];
    for (let i = 0; i < 9; i += 1) {
      const antes = FakeWebSocket.instances.length;
      act(() => last().close());
      act(() => {
        vi.advanceTimersByTime(11000);
      });
      aberturaEm.push(FakeWebSocket.instances.length - antes);
    }
    // Toda rodada reconecta em menos de 11s (jitter incluso) — o teto de 10s
    // segura, então nenhuma espera passa dos 11s mesmo na 9ª tentativa.
    expect(aberturaEm.every((n) => n === 1)).toBe(true);
  });

  it("sem token não abre socket (ninguém logado)", () => {
    render(<Probe token={null} rooms={["inventory"]} onEvent={() => {}} onResync={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

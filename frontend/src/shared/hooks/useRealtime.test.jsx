import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealtime } from "./useRealtime";

/**
 * O dublê de WebSocket precisa guardar as instâncias: a reconexão só existe
 * quando o `onclose` de um socket chama o `connect` de outro, e o hook cria o
 * socket dentro de um `setTimeout` com backoff (fake timers).
 */
class FakeSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  drop() {
    this.onclose?.();
  }

  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function Probe({ onEvent, onReconnect }) {
  useRealtime("token-123", ["alerts"], onEvent, onReconnect);
  return null;
}

describe("useRealtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("entra nas rooms e entrega as mensagens", () => {
    const onEvent = vi.fn();
    render(<Probe onEvent={onEvent} />);
    const ws = FakeSocket.instances[0];

    act(() => ws.open());
    expect(ws.protocols).toEqual(["token-123"]); // token por subprotocol
    expect(ws.sent).toEqual([{ type: "join", room: "alerts" }]);

    act(() => ws.emit({ type: "alert.created", payload: { id: "a-1" } }));
    expect(onEvent).toHaveBeenCalledWith({ type: "alert.created", payload: { id: "a-1" } });
  });

  it("avisa reconexão a partir da SEGUNDA abertura (a primeira é a montagem)", () => {
    const onReconnect = vi.fn();
    render(<Probe onEvent={vi.fn()} onReconnect={onReconnect} />);

    act(() => FakeSocket.instances[0].open());
    expect(onReconnect).not.toHaveBeenCalled(); // quem chama já carregou por GET

    act(() => FakeSocket.instances[0].drop());
    act(() => vi.advanceTimersByTime(1000)); // backoff do primeiro retry
    act(() => FakeSocket.instances[1].open());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("reconecta com backoff e ignora socket que já foi substituído", () => {
    const onReconnect = vi.fn();
    render(<Probe onEvent={vi.fn()} onReconnect={onReconnect} />);
    const first = FakeSocket.instances[0];

    act(() => first.open());
    act(() => first.drop());
    act(() => vi.advanceTimersByTime(1000));
    const second = FakeSocket.instances[1];
    act(() => second.open());

    // `onclose` do socket velho não pode agendar um terceiro socket: o hook
    // compara com o socket atual antes de reconectar.
    act(() => first.drop());
    act(() => vi.advanceTimersByTime(10000));
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

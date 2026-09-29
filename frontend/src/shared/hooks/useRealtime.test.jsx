import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealtime } from "./useRealtime";

/**
 * O backend não faz buffer de evento perdido (`sync.request` responde vazio),
 * então a única defesa contra tela velha é o `onReconnect` disparado a cada
 * (re)abertura depois da primeira. Este teste cobre as três coisas que o
 * deploy sem downtime e a queda de rede dependem:
 *   1. quem monta já carregou por GET, então a PRIMEIRA abertura não dispara
 *      o callback (seria um refetch duplicado a cada login);
 *   2. reconectar reconfere o estado por REST (o evento emitido durante a
 *      queda não volta — o outbox já marcou como publicado);
 *   3. o primeiro retry é rápido: backoff de 1s fixo era justamente o que dava
 *      a impressão de tela travada logo após um corte.
 *
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

  // Fechamento local (unmount / troca de token): o navegador dispara o
  // `onclose` depois, e o hook ignora porque o socket já não é o atual.
  close() {
    this.closed = true;
  }

  // O servidor (ou a rede) cortou a conexão: dispara o `onclose` agora.
  drop() {
    this.onclose?.();
  }

  open() {
    this.onopen?.();
  }

  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

function Probe({ token = "token-123", rooms = ["alerts"], onEvent, onReconnect }) {
  useRealtime(token, rooms, onEvent, onReconnect);
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
    const onReconnect = vi.fn();
    render(
      <Probe rooms={["kitchen-display", "inventory"]} onEvent={onEvent} onReconnect={onReconnect} />,
    );

    act(() => last().open());
    expect(last().protocols).toEqual(["token-123"]); // token por subprotocol (2.3)
    expect(last().url).not.toContain("token-123");
    expect(last().sent).toEqual([
      { type: "join", room: "kitchen-display" },
      { type: "join", room: "inventory" },
    ]);
    // A montagem já carregou por GET: a primeira abertura não refaz a busca.
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => last().emit({ type: "order.item.created", payload: { orderId: "o-1" } }));
    expect(onEvent).toHaveBeenCalledWith({ type: "order.item.created", payload: { orderId: "o-1" } });
  });

  it("avisa reconexão a partir da SEGUNDA abertura (a primeira é a montagem)", () => {
    const onReconnect = vi.fn();
    render(<Probe onEvent={vi.fn()} onReconnect={onReconnect} />);

    act(() => last().open());
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => last().drop());
    act(() => vi.advanceTimersByTime(250)); // primeiro retry: base 250ms + jitter
    expect(FakeSocket.instances).toHaveLength(2);

    act(() => last().open());
    expect(onReconnect).toHaveBeenCalledTimes(1);

    act(() => last().drop());
    act(() => vi.advanceTimersByTime(10000));
    act(() => last().open());
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("reconecta com backoff e ignora socket que já foi substituído", () => {
    render(<Probe onEvent={vi.fn()} onReconnect={vi.fn()} />);
    const first = FakeSocket.instances[0];

    act(() => first.open());
    act(() => first.drop());
    act(() => vi.advanceTimersByTime(250));
    const second = FakeSocket.instances[1];
    act(() => second.open());

    // `onclose` do socket velho não pode agendar um terceiro socket: o hook
    // compara com o socket atual antes de reconectar.
    act(() => first.drop());
    act(() => vi.advanceTimersByTime(10000));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("primeiro retry é rápido: entre 125ms e 250ms", () => {
    render(<Probe rooms={[]} onEvent={() => {}} onReconnect={() => {}} />);
    act(() => last().open());
    act(() => last().drop());

    // Ainda não conectou de novo no meio do jitter…
    act(() => vi.advanceTimersByTime(100));
    expect(FakeSocket.instances).toHaveLength(1);

    // …e já conectou no fim dele.
    act(() => vi.advanceTimersByTime(150));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("backoff cresce e tem teto de 10s (não martela o servidor)", () => {
    render(<Probe rooms={[]} onEvent={() => {}} onReconnect={() => {}} />);
    act(() => last().open());

    const aberturaEm = [];
    for (let i = 0; i < 9; i += 1) {
      const antes = FakeSocket.instances.length;
      act(() => last().drop());
      act(() => vi.advanceTimersByTime(11000));
      aberturaEm.push(FakeSocket.instances.length - antes);
    }
    // Toda rodada reconecta em menos de 11s (jitter incluso) — o teto de 10s
    // segura, então nenhuma espera passa dos 11s mesmo na 9ª tentativa.
    expect(aberturaEm.every((n) => n === 1)).toBe(true);
  });

  it("sem token não abre socket (ninguém logado)", () => {
    render(<Probe token={null} rooms={["inventory"]} onEvent={() => {}} onReconnect={() => {}} />);
    act(() => vi.advanceTimersByTime(30000));
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

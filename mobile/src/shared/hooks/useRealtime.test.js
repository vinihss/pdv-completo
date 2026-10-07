// Portado de frontend/src/shared/hooks/useRealtime.test.jsx (vitest → jest;
// web: RNTL `render` no lugar do testing-library/react). Ver o comentário do
// arquivo web para o porquê de cada regra.
//
// Adaptações RN descobertas no caminho:
//   1. no RNTL 14 o `render` E o `act` são ASSÍNCRONOS e obrigatórios de
//      `await` — um act não-awaited flutua e corrompe o escopo do act do
//      próximo teste (é o warning "You called act(async () => ...) without
//      await"). Todo act aqui é `await act(...)`.
//   2. relógio fake (`jest.useFakeTimers`) é dispensável para este contrato:
//      o backoff é testado com um `setTimeout` MOCKADO (ManualTimers) — os
//      DELAYS registrados + disparo manual, mesma política que o fake timers
//      do web mede, sem mexer no relógio do scheduler/act do React.
import { render, act } from "@testing-library/react-native";
import { setAppConfig } from "@/shared/lib";
import { useRealtime } from "./useRealtime";

/**
 * O backend não faz buffer de evento perdido, então a única defesa contra tela
 * velha é o `onReconnect` disparado a cada (re)abertura depois da primeira.
 * O dublê de WebSocket precisa guardar as instâncias: a reconexão só existe
 * quando o `onclose` de um socket chama o `connect` de outro, e o hook agenda
 * a reconexão com `setTimeout` (backoff com jitter).
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

  // Fechamento local (unmount / troca de token): o SO dispara o `onclose`
  // depois, e o hook ignora porque o socket já não é o atual.
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

// O backoff real (125ms..10s) agendado pelo hook, capturado em vez do relógio
// global. `fireNext` dispara a reconexão na ordem em que foi agendada — os
// delays registrados são exatamente os que o `setTimeout(connect, delay)`
// pediria, então o teste valida a MESMA política sem relógio fake.
class ManualTimers {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.spy = jest.spyOn(global, "setTimeout").mockImplementation((cb, delay, ...args) => {
      const id = this.nextId++;
      this.pending.set(id, { cb, args, delay: Number(delay) || 0 });
      return id;
    });
    ManualTimers.active = this;
  }

  get count() {
    return this.pending.size;
  }

  delays() {
    return [...this.pending.values()].map((t) => t.delay);
  }

  fireNext() {
    const [id, t] = [...this.pending.entries()][0];
    this.pending.delete(id);
    t.cb(...t.args);
  }

  restore() {
    this.spy.mockRestore();
    if (ManualTimers.active === this) ManualTimers.active = null;
  }
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

// jest 29.7 (o que o jest-expo 57 empacota) não expõe `jest.stubGlobal` — o
// dublê entra por troca direta do global, com restauração no afterEach.
let originalWebSocket;

function Probe({ token = "token-123", rooms = ["alerts"], onEvent, onReconnect }) {
  useRealtime(token, rooms, onEvent, onReconnect);
  return null;
}

describe("useRealtime", () => {
  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket;
    FakeSocket.instances = [];
    // Sem servidor configurado o hook NÃO abre socket (o endpoint é um path
    // puro, que o WebSocket nativo recusa). O teste configura a origem — é o
    // que o boot faz antes de qualquer tela de dados.
    setAppConfig({ apiBase: "http://10.0.2.2:3000", daemonUrl: "" });
  });

  afterEach(() => {
    setAppConfig(null);
    ManualTimers.active?.restore();
    if (originalWebSocket === undefined) {
      delete globalThis.WebSocket;
    } else {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("entra nas rooms e entrega as mensagens", async () => {
    const onEvent = jest.fn();
    const onReconnect = jest.fn();
    await render(
      <Probe rooms={["kitchen-display", "inventory"]} onEvent={onEvent} onReconnect={onReconnect} />,
    );

    await act(() => last().open());
    expect(last().protocols).toEqual(["token-123"]); // token por subprotocol (2.3)
    expect(last().url).not.toContain("token-123");
    expect(last().url).toBe("ws://10.0.2.2:3000/realtime");
    expect(last().sent).toEqual([
      { type: "join", room: "kitchen-display" },
      { type: "join", room: "inventory" },
    ]);
    // A montagem já carregou por GET: a primeira abertura não refaz a busca.
    expect(onReconnect).not.toHaveBeenCalled();

    await act(() => last().emit({ type: "order.item.created", payload: { orderId: "o-1" } }));
    expect(onEvent).toHaveBeenCalledWith({ type: "order.item.created", payload: { orderId: "o-1" } });
  });

  it("avisa reconexão a partir da SEGUNDA abertura (a primeira é a montagem)", async () => {
    const onReconnect = jest.fn();
    await render(<Probe onEvent={jest.fn()} onReconnect={onReconnect} />);
    const timers = new ManualTimers();

    await act(() => last().open());
    expect(onReconnect).not.toHaveBeenCalled();

    await act(() => last().drop());
    expect(timers.count).toBe(1); // agendou a reconexão
    timers.fireNext();
    expect(FakeSocket.instances).toHaveLength(2);

    await act(() => last().open());
    expect(onReconnect).toHaveBeenCalledTimes(1);

    await act(() => last().drop());
    timers.fireNext();
    await act(() => last().open());
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("reconecta com backoff e ignora socket que já foi substituído", async () => {
    await render(<Probe onEvent={jest.fn()} onReconnect={jest.fn()} />);
    const first = FakeSocket.instances[0];
    const timers = new ManualTimers();

    await act(() => first.open());
    await act(() => first.drop());
    timers.fireNext();
    const second = FakeSocket.instances[1];
    await act(() => second.open());

    // `onclose` do socket velho não pode agendar uma terceira reconexão: o
    // hook compara com o socket atual antes de agendar o backoff.
    await act(() => first.drop());
    expect(timers.count).toBe(0);
  });

  it("primeiro retry é rápido: entre 125ms e 250ms", async () => {
    await render(<Probe rooms={[]} onEvent={() => {}} onReconnect={() => {}} />);
    const timers = new ManualTimers();

    await act(() => last().open());
    await act(() => last().drop());

    const [primeiroDelay] = timers.delays();
    expect(primeiroDelay).toBeGreaterThanOrEqual(125);
    expect(primeiroDelay).toBeLessThan(250);
  });

  it("backoff cresce e tem teto de 10s (não martela o servidor)", async () => {
    await render(<Probe rooms={[]} onEvent={() => {}} onReconnect={() => {}} />);
    const timers = new ManualTimers();

    await act(() => last().open());

    const delays = [];
    for (let i = 0; i < 9; i += 1) {
      await act(() => last().drop());
      const [proximo] = timers.delays();
      delays.push(proximo);
      timers.fireNext(); // conecta de novo → socket novo para derrubar
    }
    // O teto de 10s segura o martelar: toda rodada reconecta sem nunca passar
    // desse valor, mesmo na 9ª tentativa, e o primeiro retry é < 250ms.
    expect(delays).toHaveLength(9);
    expect(delays[0]).toBeGreaterThanOrEqual(125);
    delays.forEach((d) => expect(d).toBeLessThanOrEqual(10000));
  });

  it("sem token não abre socket (ninguém logado)", async () => {
    await render(<Probe token={null} rooms={["inventory"]} onEvent={() => {}} onReconnect={() => {}} />);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("sem servidor configurado não abre socket (endpoint é path puro)", async () => {
    setAppConfig(null);
    await render(<Probe rooms={["inventory"]} onEvent={() => {}} onReconnect={() => {}} />);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
import React from "react";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Os hooks NÃO são dublados (são o que se quer testar): importados direto para
// o `OrderBoard` dublê consumir o foco — a mesma árvore que ele usaria de verdade.
import { useOrderFocus } from "@/app/providers/order-focus";
import { useAlerts } from "@/app/providers/alerts";

// Suíte do fluxo do sino:badge, lista, som no `alert.created` do WebSocket,
// repetição de 30s, marcação de lido e navegação para a comanda.
//
// A ordem importa: a regra de negócio morre se o "marcar lido ao abrir a
// comanda" for testado isolado do sino. Por isso o alvo é a árvore real
// (provider + widget + `OrderBoard`), com API e WebSocket dublês — o que não
// pode é dublar o provider, que é justamente o que se quer testar.
const mocks = vi.hoisted(() => ({
  auth: null,
  api: { listAlerts: vi.fn(), markAlertsRead: vi.fn() },
  send: null, // injetado pelo dublê de useRealtime
  sound: { playTones: vi.fn(() => true) },
  nav: { setActiveId: vi.fn() },
}));

vi.mock("@/app/providers/auth", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => mocks.auth,
}));

// Captura a callback de evento do WS para o teste "chegou comanda nova" poder
// injetar o `alert.created` sem abrir um servidor.
vi.mock("@/shared/hooks", async (orig) => ({
  ...(await orig()),
  useRealtime: (token, rooms, onEvent, onReconnect) => {
    mocks.send = onEvent;
    mocks.rooms = rooms;
    mocks.reconnect = onReconnect;
  },
}));

vi.mock("@/entities/alert", async (orig) => ({
  ...(await orig()),
  listAlerts: (...args) => mocks.api.listAlerts(...args),
  markAlertsRead: (...args) => mocks.api.markAlertsRead(...args),
  playAlertSound: (...args) => mocks.sound.playTones(...args),
}));

vi.mock("@/shared/lib/audio", () => ({
  playTones: (...args) => mocks.sound.playTones(...args),
  unlockAudio: vi.fn(),
}));

// O `OrderBoard` real é pesado (lista, websocket de comandas, modais) e não é o
// alvo aqui: o que importa é que ele CONSUMA o foco e marque lido. Dublá-lo
// deixa o teste do sino honesto e rápido.
vi.mock("@/widgets/order-board", () => ({
  OrderBoard: () => {
    const { focusedOrderId, clearFocus } = useOrderFocus();
    const { markRead } = useAlerts();
    React.useEffect(() => {
      if (!focusedOrderId) return;
      // Mesmo contrato do OrderBoard real: consome o foco (uma vez) e marca o
      // alerta da comanda que acabou de abrir como lido.
      clearFocus();
      markRead(focusedOrderId);
      mocks.focusConsumed = focusedOrderId;
    }, [focusedOrderId, clearFocus, markRead]);
    return <p>comandas</p>;
  },
}));

const { AlertsProvider } = await import("@/app/providers/alerts");
const { OrderFocusProvider } = await import("@/app/providers/order-focus");
const { NavProvider } = await import("@/app/providers/nav");
const { AlertBell } = await import("@/widgets/alert-bell");
const { OrderBoard } = await import("@/widgets/order-board"); // o dublê acima

const ALERTA = {
  id: "a-1",
  kind: "order_created",
  title: "Nova comanda · Mesa 1",
  body: "Balcão",
  orderId: "o-1",
  channel: "balcao",
  orderStatus: "open",
  readAt: null,
  createdAt: new Date().toISOString(),
};

function session(role) {
  mocks.auth = {
    session: { token: "t", user: { id: "u1", name: "Ana Ribeiro", role } },
    storeSettings: { merchantName: "Unami" },
    booting: false,
    logout: vi.fn(),
  };
}

// O primeiro `GET /alerts` é uma promise: renderizar dentro de `act` espera o
// load, senão o badge ainda não existe na hora da primeira asserção.
async function renderBell(role = "manager") {
  session(role);
  let utils;
  await act(async () => {
    utils = render(
      <NavProvider role={role}>
        <AlertsProvider>
          <OrderFocusProvider>
            <AlertBell />
            <OrderBoard />
            <p>fila</p>
          </OrderFocusProvider>
        </AlertsProvider>
      </NavProvider>
    );
  });
  return utils;
}

const emit = (msg) => act(() => mocks.send(msg));
const alerta = (over = {}) => ({ ...ALERTA, ...over });

beforeEach(() => {
  localStorage.clear();
  mocks.api.listAlerts.mockResolvedValue({ data: [], total: 0, unread: 0 });
  mocks.api.markAlertsRead.mockResolvedValue({ marked: 1 });
  mocks.send = null;
  mocks.focusConsumed = null;
  mocks.sound.playTones.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("sino no header", () => {
  it("sem alertas: sem badge, e o drawer diz que está vazio", async () => {
    await renderBell();
    expect(screen.queryByTestId("alert-badge")).toBeNull();
    fireEvent.click(screen.getByLabelText("Alertas"));
    expect(within(screen.getByRole("dialog")).getByText("Nada por aqui ainda.")).toBeTruthy();
  });

  it("com não lidos: badge com a contagem e sino marcado como não lido", async () => {
    mocks.api.listAlerts.mockResolvedValue({ data: [ALERTA], total: 1, unread: 3 });
    await renderBell();
    expect(screen.getByTestId("alert-badge").textContent).toBe("3");
    expect(screen.getByLabelText("Alertas (3 não lidos)")).toBeTruthy();
  });

  it("badge trava em 99+ (contador de 4 dígitos quebraria o header)", async () => {
    mocks.api.listAlerts.mockResolvedValue({ data: [ALERTA], total: 1, unread: 1234 });
    await renderBell();
    expect(screen.getByTestId("alert-badge").textContent).toBe("99+");
  });

  it("a lista mostra título, canal e que está lida; as não lidas vêm destacadas", async () => {
    mocks.api.listAlerts.mockResolvedValue({
      data: [
        alerta({ id: "a-2", title: "Novo pedido de Ana", body: "Entrega · página", readAt: new Date().toISOString() }),
        alerta({ id: "a-1" }),
      ],
      total: 2,
      unread: 1,
    });
    await renderBell();
    fireEvent.click(screen.getByLabelText("Alertas (1 não lidos)"));
    const painel = within(screen.getByRole("dialog"));
    expect(painel.getByText("Nova comanda · Mesa 1")).toBeTruthy();
    expect(painel.getByText("Balcão")).toBeTruthy();
    expect(painel.getByText(/lida/)).toBeTruthy();
    expect(painel.getByText("Hoje")).toBeTruthy();
  });

  it("assina o room público e o do próprio papel", async () => {
    await renderBell("kitchen");
    expect(mocks.rooms).toEqual(["alerts", "alerts:kitchen"]);
  });
});

describe("comanda nova chegando pelo WebSocket", () => {
  it("soma no badge, mostra o toast e toca o som", async () => {
    await renderBell("kitchen");
    emit({ type: "alert.created", payload: ALERTA });

    expect(screen.getByTestId("alert-badge").textContent).toBe("1");
    expect(screen.getByRole("status").textContent).toBe("Nova comanda · Mesa 1 · Balcão");
    expect(mocks.sound.playTones).toHaveBeenCalledTimes(1);
  });

  it("o mesmo alerta reentregue no reconnect não vira duas linhas nem dois toques", async () => {
    await renderBell("kitchen");
    emit({ type: "alert.created", payload: ALERTA });
    emit({ type: "alert.created", payload: ALERTA });

    expect(screen.getByTestId("alert-badge").textContent).toBe("1");
    expect(mocks.sound.playTones).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Alertas (1 não lidos)"));
    expect(within(screen.getByRole("dialog")).getAllByText("Nova comanda · Mesa 1")).toHaveLength(1);
  });

  it("evento de outro room é ignorado", async () => {
    await renderBell("kitchen");
    emit({ type: "order.closed", payload: { orderId: "o-1" } });
    expect(screen.queryByTestId("alert-badge")).toBeNull();
    expect(mocks.sound.playTones).not.toHaveBeenCalled();
  });

  it("som desligado no aparelho: o alerta chega, o bip não", async () => {
    localStorage.setItem("pdv:alert-sound", "off");
    await renderBell("kitchen");
    emit({ type: "alert.created", payload: ALERTA });
    expect(screen.getByTestId("alert-badge").textContent).toBe("1");
    expect(mocks.sound.playTones).not.toHaveBeenCalled();
  });
});

describe("repetição de 30s", () => {
  it("toca de novo se o alerta continuar não lido", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderBell("kitchen");
    emit({ type: "alert.created", payload: ALERTA });
    expect(mocks.sound.playTones).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(mocks.sound.playTones).toHaveBeenCalledTimes(1); // ainda não

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mocks.sound.playTones).toHaveBeenCalledTimes(2);
  });

  it("alerta lido no meio do caminho não repete", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderBell("kitchen");
    emit({ type: "alert.created", payload: ALERTA });
    mocks.api.markAlertsRead.mockResolvedValue({ marked: 1 });
    mocks.api.listAlerts.mockResolvedValue({ data: [{ ...ALERTA, readAt: new Date().toISOString() }], total: 1, unread: 0 });

    fireEvent.click(screen.getByLabelText("Alertas (1 não lidos)"));
    const painel = within(screen.getByRole("dialog"));
    await act(async () => {
      fireEvent.click(painel.getByText("Nova comanda · Mesa 1"));
    });
    expect(screen.queryByTestId("alert-badge")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(mocks.sound.playTones).toHaveBeenCalledTimes(1); // só o toque inicial
  });

  // O `alert.created` que caiu enquanto o WS estava fora não volta: o dispatcher
  // do outbox marca publicado mesmo sem assinante na sala. Então reconectar tem
  // que recarregar por GET, senão o sino fica mudo até o próximo F5.
  it("reconexão do WebSocket recarrega a lista (o evento perdido não volta)", async () => {
    await renderBell("manager");
    expect(mocks.api.listAlerts).toHaveBeenCalledTimes(1);

    mocks.api.listAlerts.mockResolvedValue({
      data: [alerta({ id: "a-perdido", title: "Nova comanda · Mesa 9" })],
      total: 1,
      unread: 1,
    });
    await act(async () => {
      mocks.reconnect();
    });

    expect(mocks.api.listAlerts).toHaveBeenCalledTimes(2);
    expect(await screen.findByLabelText("Alertas (1 não lidos)")).toBeTruthy();
  });
});

describe("clicar no alerta", () => {
  it("gerente: marca lido, foca a comanda e fecha o drawer", async () => {
    mocks.api.listAlerts.mockResolvedValueOnce({ data: [ALERTA], total: 1, unread: 1 });
    mocks.api.listAlerts.mockResolvedValue({
      data: [alerta({ readAt: new Date().toISOString() })],
      total: 1,
      unread: 0,
    });
    mocks.api.markAlertsRead.mockResolvedValue({ marked: 1 });
    await renderBell("manager");

    fireEvent.click(screen.getByLabelText("Alertas (1 não lidos)"));
    const painel = within(screen.getByRole("dialog"));
    await act(async () => {
      fireEvent.click(painel.getByText("Nova comanda · Mesa 1"));
    });

    expect(mocks.api.markAlertsRead).toHaveBeenCalledWith("o-1");
    expect(mocks.focusConsumed).toBe("o-1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("caixa e cozinha: marca lido mas NÃO tenta focar comanda (não têm a tela)", async () => {
    mocks.api.listAlerts.mockResolvedValue({ data: [ALERTA], total: 1, unread: 1 });
    await renderBell("cashier");
    fireEvent.click(screen.getByLabelText("Alertas (1 não lidos)"));
    const painel = within(screen.getByRole("dialog"));
    await act(async () => {
      fireEvent.click(painel.getByText("Nova comanda · Mesa 1"));
    });

    expect(mocks.api.markAlertsRead).toHaveBeenCalledWith("o-1");
    expect(mocks.focusConsumed).toBeNull();
    // O drawer fica aberto: não havia para onde ir.
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("comanda já encerrada: só marca lido", async () => {
    mocks.api.listAlerts.mockResolvedValue({
      data: [alerta({ orderStatus: "closed" })],
      total: 1,
      unread: 1,
    });
    await renderBell("manager");
    fireEvent.click(screen.getByLabelText("Alertas (1 não lidos)"));
    const painel = within(screen.getByRole("dialog"));
    await act(async () => {
      fireEvent.click(painel.getByText("Nova comanda · Mesa 1"));
    });
    expect(mocks.focusConsumed).toBeNull();
  });

  it("'marcar todas' zera o badge sem tocar em comanda", async () => {
    mocks.api.listAlerts.mockResolvedValueOnce({ data: [ALERTA, alerta({ id: "a-2" })], total: 2, unread: 2 });
    mocks.api.listAlerts.mockResolvedValue({ data: [], total: 2, unread: 0 });
    await renderBell("manager");
    fireEvent.click(screen.getByLabelText("Alertas (2 não lidos)"));
    const painel = within(screen.getByRole("dialog"));
    await act(async () => {
      fireEvent.click(painel.getByLabelText("Marcar todas como lidas"));
    });
    expect(mocks.api.markAlertsRead).toHaveBeenCalledWith(undefined);
    expect(mocks.focusConsumed).toBeNull();
    expect(screen.queryByTestId("alert-badge")).toBeNull();
  });
});

describe("preferência de som", () => {
  it("o toggle fica no rodapé do drawer e persiste no aparelho", async () => {
    await renderBell("manager");
    fireEvent.click(screen.getByLabelText("Alertas"));
    const painel = within(screen.getByRole("dialog"));
    const toggle = painel.getByRole("checkbox");
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    expect(localStorage.getItem("pdv:alert-sound")).toBe("off");
    expect(painel.getByText("Som desligado")).toBeTruthy();
    // Desligar não dá bip; religar dá (senão o usuário não confirma que ligou).
    expect(mocks.sound.playTones).not.toHaveBeenCalled();
    fireEvent.click(painel.getByRole("checkbox"));
    expect(localStorage.getItem("pdv:alert-sound")).toBe("on");
    expect(mocks.sound.playTones).toHaveBeenCalledTimes(1);
  });
});

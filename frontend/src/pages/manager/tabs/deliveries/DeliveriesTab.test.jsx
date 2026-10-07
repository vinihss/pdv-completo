import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Rede de proteção do card de entrega: o que o gerente precisa ver (nome de
// quem pediu, endereço, quando caiu e quando saiu) e o que o clique promete
// (abrir a comanda).
//
// Dublados: `useDeliveries` (evita WebSocket + fetch), `useOrderFocus` (o
// provider real já é coberto pelo AlertBell.test.jsx, com a árvore inteira) e
// `cancelOrder` (o cancelamento passa por `ConfirmModal`, então o teste precisa
// do botão de confirmar para não sair pra rede).
const mocks = vi.hoisted(() => ({
  useDeliveries: vi.fn(),
  assignCourier: vi.fn(),
  focusOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));

vi.mock("@/entities/delivery", async (orig) => ({
  ...(await orig()),
  useDeliveries: (...args) => mocks.useDeliveries(...args),
  assignCourier: (...args) => mocks.assignCourier(...args),
}));

vi.mock("@/entities/order", async (orig) => ({
  ...(await orig()),
  cancelOrder: (...args) => mocks.cancelOrder(...args),
}));

vi.mock("@/app/providers/order-focus", () => ({
  useOrderFocus: () => ({ focusOrder: mocks.focusOrder }),
}));

const { default: DeliveriesTab } = await import("./DeliveriesTab.jsx");

// Datas montadas a partir de componentes locais: `formatDateTime` formata no
// fuso da máquina, então um ISO fixo renderizaria "29/09 19:30" num CI em UTC
// e "29/09 14:30" aqui.
const CRIADA_EM = new Date(2026, 8, 29, 14, 30).toISOString();
const ENTREGUE_EM = new Date(2026, 8, 29, 15, 5).toISOString();

const ENTREGA = {
  id: "d-1",
  orderId: "abcdefgh-1234-5678-9012-abcdefabcdef",
  address: "Rua das Flores, 123 - Centro, Sao Paulo",
  status: "awaiting_courier",
  courierId: null,
  courier: null,
  customerName: "Maria Silva",
  createdAt: CRIADA_EM,
  dispatchedAt: null,
  deliveredAt: null,
  notes: null,
};

const ENTREGADOR = { id: "u-2", name: "Carlos Lima", active: true };

// Aceita uma entrega (forma antiga) ou uma lista — os testes de ordenação
// precisam de várias na mesma tela.
function setup(delivery = ENTREGA) {
  const list = Array.isArray(delivery) ? delivery : [delivery];
  mocks.useDeliveries.mockReturnValue({
    deliveries: list,
    couriers: [ENTREGADOR],
    loading: false,
    reload: vi.fn(),
  });
  const showToast = vi.fn();
  render(<DeliveriesTab showToast={showToast} />);
  return { showToast };
}

// Nomes dos cards, na ordem em que foram renderizados.
function nomesDosCards() {
  return screen.getAllByTestId("delivery-card").map((c) => c.textContent);
}

beforeEach(() => {
  cleanup();
  mocks.focusOrder.mockClear();
  mocks.assignCourier.mockClear();
  mocks.cancelOrder.mockClear();
});

describe("DeliveriesTab — card de entrega", () => {
  it("mostra nome, endereço e a data em que o pedido caiu", () => {
    setup();

    expect(screen.getByText("Maria Silva")).toBeTruthy();
    expect(screen.getByText(ENTREGA.address)).toBeTruthy();
    // `^` ancora no começo do <p>, que é onde mora a data de criação.
    expect(screen.getByTestId("delivery-datetime").textContent).toContain("29/09");
    expect(screen.getByTestId("delivery-datetime").textContent).toContain("14:30");
  });

  it("sem cliente resolvido, mostra o endereço em vez de esconder o card", () => {
    setup({ ...ENTREGA, customerName: null });

    expect(screen.getByText("— sem nome —")).toBeTruthy();
    expect(screen.getByText(ENTREGA.address)).toBeTruthy();
  });

  it("entrega concluída mostra também quando foi entregue", () => {
    setup({ ...ENTREGA, status: "delivered", courier: ENTREGADOR, deliveredAt: ENTREGUE_EM });

    const toggle = screen.getByLabelText(/Mostrar entregues e canceladas/);
    fireEvent.click(toggle);

    const dt = screen.getByTestId("delivery-datetime");
    expect(dt.textContent).toContain("29/09");
    expect(dt.textContent).toContain("14:30");
    expect(dt.textContent).toContain("Entregue");
    expect(dt.textContent).toContain("15:05");
  });

  it("clicar no card abre a comanda da entrega", () => {
    setup();

    fireEvent.click(screen.getByText("Maria Silva"));

    expect(mocks.focusOrder).toHaveBeenCalledWith(ENTREGA.orderId);
  });

  it("Enter no card abre a comanda; Espaço num controle dentro do card não", () => {
    setup();

    // Espaço no <select> é o teclado do dropdown: se vazasse para o card,
    // atribuir entregador também abriria a comanda.
    fireEvent.keyDown(screen.getByLabelText(/Atribuir entregador/), { key: " " });
    expect(mocks.focusOrder).not.toHaveBeenCalled();

    // O card é o alvo do teclado (role=button, tabIndex=0): o evento sai
    // dele, não do <p> interno.
    fireEvent.keyDown(screen.getByRole("button", { name: /Abrir comanda de Maria Silva/ }), { key: "Enter" });
    expect(mocks.focusOrder).toHaveBeenCalledWith(ENTREGA.orderId);
  });

  it("atribuir entregador não dispara a abertura da comanda", () => {
    setup();

    fireEvent.change(screen.getByLabelText(/Atribuir entregador/), { target: { value: ENTREGADOR.id } });

    expect(mocks.assignCourier).toHaveBeenCalledWith(ENTREGA.id, ENTREGADOR.id);
    expect(mocks.focusOrder).not.toHaveBeenCalled();
  });

  it("cancelar pedido (bloco de falha) não dispara a abertura da comanda", () => {
    setup({ ...ENTREGA, status: "failed", notes: "cliente ausente" });

    fireEvent.click(screen.getByText("Cancelar pedido"));

    // Abriu o campo de motivo, e não a comanda.
    expect(screen.getByPlaceholderText("Motivo do cancelamento")).toBeTruthy();
    expect(mocks.focusOrder).not.toHaveBeenCalled();
  });
});

// A fila do balcão é trabalho pendente, não histórico: a entrega mais antiga é
// a mais urgente e não pode ficar no fim da tela. O backend entrega DESC por
// `createdAt` (contrato em docs/05-delivery-api-contracts.md:314), então o
// resort acontece no cliente — os testes alimentam a lista na ordem do
// servidor e esperam a ordem de trabalho na tela.
describe("DeliveriesTab — fila por urgência", () => {
  const emMin = (h, m) => new Date(2026, 8, 29, h, m).toISOString();
  const comNome = (id, customerName, createdAt, extra = {}) => ({
    ...ENTREGA,
    id,
    customerName,
    createdAt,
    ...extra,
  });

  it("põe a mais antiga entre as aguardando entregador em primeiro lugar", () => {
    const antiga = comNome("d-antiga", "Pedido Antigo", emMin(14, 0));
    const media = comNome("d-media", "Pedido do Meio", emMin(14, 15));
    const recente = comNome("d-recente", "Pedido Recente", emMin(14, 45));

    // Na ordem do backend: DESC, o que caiu por último vem primeiro.
    setup([recente, media, antiga]);

    expect(nomesDosCards()).toEqual([
      expect.stringContaining("Pedido Antigo"),
      expect.stringContaining("Pedido do Meio"),
      expect.stringContaining("Pedido Recente"),
    ]);
  });

  it("aguardando entregador vem antes de a caminho, mesmo sendo mais recente", () => {
    const aguardando = comNome("d-aguardando", "Ainda Parada", emMin(14, 40));
    const aCaminho = comNome("d-a-caminho", "Já Saiu", emMin(13, 10), {
      status: "out_for_delivery",
      courier: ENTREGADOR,
    });

    // A mais antiga das duas é a que JÁ FOI resolvida parcialmente — mas o
    // que falta resolver (ninguém atribuído) sobe.
    setup([aCaminho, aguardando]);

    expect(nomesDosCards()).toEqual([
      expect.stringContaining("Ainda Parada"),
      expect.stringContaining("Já Saiu"),
    ]);
  });

  it("dentro de a caminho também vale a mais antiga primeiro", () => {
    const saiuPrimeiro = comNome("d-saiu-1", "Saiu às 13h", emMin(13, 0), {
      status: "out_for_delivery",
      courier: ENTREGADOR,
    });
    const saiuDepois = comNome("d-saiu-2", "Saiu às 14h", emMin(14, 0), {
      status: "out_for_delivery",
      courier: ENTREGADOR,
    });

    setup([saiuDepois, saiuPrimeiro]);

    expect(nomesDosCards()).toEqual([
      expect.stringContaining("Saiu às 13h"),
      expect.stringContaining("Saiu às 14h"),
    ]);
  });
});

describe("DeliveriesTab — cancelar pedido com confirmação", () => {
  const FALHOU = { ...ENTREGA, status: "failed", notes: "cliente ausente" };

  it("passa pelo ConfirmModal destrutivo e só então chama o cancelamento", async () => {
    setup(FALHOU);

    fireEvent.click(screen.getByText("Cancelar pedido"));
    fireEvent.click(screen.getByText("Revisar cancelamento"));

    // A confirmação existe: cancelamento é irreversível e avisa o cliente.
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-label")).toBe("Cancelar pedido?");
    // O motivo digitado aparece na confirmação — é o que o cliente vai ler.
    expect(dialog.textContent).toContain("cliente ausente");
    expect(mocks.cancelOrder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Sim, cancelar pedido"));

    await waitFor(() =>
      expect(mocks.cancelOrder).toHaveBeenCalledWith(ENTREGA.orderId, "cliente ausente")
    );
  });

  it("cancelar na confirmação não chama a API e volta ao card", () => {
    setup(FALHOU);

    fireEvent.click(screen.getByText("Cancelar pedido"));
    fireEvent.click(screen.getByText("Revisar cancelamento"));
    fireEvent.click(screen.getByText("Cancelar"));

    expect(mocks.cancelOrder).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // O card continua como estava: motivo aberto, pronto para rever.
    expect(screen.getByPlaceholderText("Motivo do cancelamento")).toBeTruthy();
  });

  it("sem motivo digitado não dá para chegar à confirmação", () => {
    setup({ ...ENTREGA, status: "failed", notes: null });

    fireEvent.click(screen.getByText("Cancelar pedido"));

    expect(screen.getByText("Revisar cancelamento").disabled).toBe(true);
  });
});

describe("DeliveriesTab — payload incompleto", () => {
  it("card sem orderId não quebra o render", () => {
    setup({ ...ENTREGA, orderId: null });

    // O `.slice()` cru estourava TypeError e derrubava a tela inteira; agora
    // o card diz que não tem número e segue mostrando o resto.
    expect(screen.getByText("Pedido sem número")).toBeTruthy();
    expect(screen.getByText("Maria Silva")).toBeTruthy();
    expect(screen.getByText(ENTREGA.address)).toBeTruthy();
  });

  it("card sem orderId continua abrindo a comanda sem quebrar", () => {
    setup({ ...ENTREGA, orderId: null });

    fireEvent.click(screen.getByText("Maria Silva"));

    expect(mocks.focusOrder).toHaveBeenCalledWith(null);
  });
});

describe("DeliveriesTab — tempo e contadores", () => {
  it("mostra há quanto tempo a entrega está parada", () => {
    setup({ ...ENTREGA, createdAt: new Date(Date.now() - 23 * 60_000).toISOString() });

    expect(screen.getByTestId("delivery-elapsed").textContent).toContain("parada há 23 min");
  });

  it("conta as entregues e canceladas mesmo com o histórico já aberto", () => {
    setup([
      { ...ENTREGA, status: "delivered", courier: ENTREGADOR, deliveredAt: ENTREGUE_EM },
      { ...ENTREGA, id: "d-2", status: "cancelled" },
    ]);

    // Antes do toggle: duas escondidas.
    expect(screen.getByLabelText(/Mostrar entregues e canceladas/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Mostrar entregues e canceladas/));

    // Aberto, o número não pode virar 0 — seria dizer "não há nada para
    // mostrar" com as duas entregas na tela.
    expect(screen.getByText(/Mostrar entregues e canceladas \(2\)/)).toBeTruthy();
  });
});

describe("DeliveriesTab — filtros das últimas 24 horas", () => {
  const recente = (id, status, ageHours = 1) => ({
    ...ENTREGA,
    id,
    customerName: id,
    status,
    createdAt: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
    courier: status === "out_for_delivery" ? ENTREGADOR : null,
  });

  it("contagens e filtros exibem os mesmos estados e limitam-se às últimas 24 horas", () => {
    setup([
      recente("aguardando", "awaiting_courier"),
      recente("em rota", "out_for_delivery"),
      recente("entregue", "delivered"),
      recente("cancelada", "cancelled"),
      recente("falhou", "failed"),
      recente("antiga", "awaiting_courier", 30),
    ]);

    expect(screen.getByTestId("delivery-filter-pending").getAttribute("aria-label")).toContain("1 entrega");
    expect(screen.getByTestId("delivery-filter-out").getAttribute("aria-label")).toContain("1 entrega");
    expect(screen.getByTestId("delivery-filter-completed").getAttribute("aria-label")).toContain("3 entregas");
    expect(screen.getByTestId("delivery-filter-last24").getAttribute("aria-label")).toContain("5 entregas");

    fireEvent.click(screen.getByTestId("delivery-filter-completed"));
    expect(screen.getAllByTestId("delivery-card")).toHaveLength(3);
    expect(screen.queryByText("antiga")).toBeNull();

    fireEvent.click(screen.getByTestId("clear-delivery-filter"));
    fireEvent.click(screen.getByTestId("delivery-filter-last24"));
    expect(screen.getAllByTestId("delivery-card")).toHaveLength(5);
    expect(screen.queryByText("antiga")).toBeNull();
  });

  it("recolhe o mapa de entregadores por padrão e o expande sob demanda", () => {
    setup(recente("em rota", "out_for_delivery"));
    const toggle = screen.getByTestId("deliveries-map-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("deliveries-map-empty")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("deliveries-map-empty")).toBeTruthy();
  });
});

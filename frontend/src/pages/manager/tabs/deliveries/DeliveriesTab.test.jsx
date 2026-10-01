import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// Rede de proteção do card de entrega: o que o gerente precisa ver (nome de
// quem pediu, endereço, quando caiu e quando saiu) e o que o clique promete
// (abrir a comanda).
//
// Dublados: `useDeliveries` (evita WebSocket + fetch) e `useOrderFocus` (o
// provider real já é coberto pelo AlertBell.test.jsx, com a árvore inteira).
const mocks = vi.hoisted(() => ({
  useDeliveries: vi.fn(),
  assignCourier: vi.fn(),
  focusOrder: vi.fn(),
}));

vi.mock("@/entities/delivery", async (orig) => ({
  ...(await orig()),
  useDeliveries: (...args) => mocks.useDeliveries(...args),
  assignCourier: (...args) => mocks.assignCourier(...args),
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

function setup(delivery = ENTREGA) {
  mocks.useDeliveries.mockReturnValue({
    deliveries: [delivery],
    couriers: [ENTREGADOR],
    loading: false,
    reload: vi.fn(),
  });
  const showToast = vi.fn();
  render(<DeliveriesTab showToast={showToast} />);
  return { showToast };
}

beforeEach(() => {
  cleanup();
  mocks.focusOrder.mockClear();
  mocks.assignCourier.mockClear();
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

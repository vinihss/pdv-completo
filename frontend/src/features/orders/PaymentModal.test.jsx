import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import PaymentModal from "./PaymentModal.jsx";

vi.mock("@/entities/order", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    setPayments: vi.fn().mockResolvedValue({ payments: [] }),
    confirmPayment: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("@/app/providers/auth", () => ({
  useAuth: () => ({ storeSettings: {} }),
}));

const defaultProps = {
  order: {
    id: "o1",
    status: "open",
    items: [{ id: "i1", name: "Cerveja", quantity: 2, unitPrice: 10, status: "ordered" }],
    payments: [],
  },
  enabledMethods: ["cash", "card", "pix"],
  storeSettings: {
    pixKey: "test@test.com",
    pixKeyType: "email",
    merchantName: "Test Merchant",
    merchantCity: "Test City",
  },
  onClose: vi.fn(),
  onConfirmed: vi.fn(),
  showToast: vi.fn(),
};

describe("PaymentModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  afterEach(cleanup);

  it("mostra resumo do pagamento com total da comanda", () => {
    render(<PaymentModal {...defaultProps} />);
    expect(screen.getByText("Total da comanda")).toBeTruthy();
    // O valor aparece múltiplas vezes (subtitle, resumo, rodapé), então verificamos se existe pelo menos um
    expect(screen.getAllByText("R$ 20,00").length).toBeGreaterThan(0);
  });

  it("mostra 'Já registrado' e 'Restante' quando há pagamentos", () => {
    const orderWithPayments = {
      ...defaultProps.order,
      payments: [
        { id: "p1", method: "cash", amount: 10, received: 10, confirmed: true },
      ],
    };
    render(<PaymentModal {...defaultProps} order={orderWithPayments} />);
    
    expect(screen.getByText("Já registrado")).toBeTruthy();
    expect(screen.getByText("Restante")).toBeTruthy();
    // O valor aparece múltiplas vezes (Já registrado e Restante)
    expect(screen.getAllByText("R$ 10,00").length).toBeGreaterThan(0);
  });

  it("não mostra 'Já registrado' quando não há pagamentos", () => {
    render(<PaymentModal {...defaultProps} />);
    expect(screen.queryByText("Já registrado")).toBeNull();
    expect(screen.queryByText("Restante")).toBeNull();
  });
});

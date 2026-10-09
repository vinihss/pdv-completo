import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ReviewCartModal from "./ReviewCartModal.jsx";

// Mock de dependências
vi.mock("@/entities/order", () => ({
  variationsText: () => null,
}));
vi.mock("@/shared/lib", () => ({
  formatBRL: (v) => `R$ ${Math.round(v * 100) / 100}`,
}));
vi.mock("@/shared/components", () => ({
  Modal: ({ children, onClose, title, footer }) => (
    <div>
      <h2>{title}</h2>
      <button onClick={onClose}>Fechar</button>
      {children}
      {footer && <div data-testid="modal-footer">{footer}</div>}
    </div>
  ),
}));

const mockProduct = { id: "p1", name: "Hamburguer", price: 25.0 };
const mockLine = {
  product: mockProduct,
  quantity: 2,
  selectedVariations: {},
  notes: "",
};

describe("ReviewCartModal", () => {
  const defaultProps = {
    lines: { "p1-{}": mockLine },
    total: 50.0,
    count: 2,
    kitchenEnabled: true,
    onClose: vi.fn(),
    onRemoveLine: vi.fn(),
    onChangeNotes: vi.fn(),
    onChangeQty: vi.fn(),
    onConfirm: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("botão mostra 'Enviar N itens para a cozinha' quando cozinha habilitada", () => {
    render(<ReviewCartModal {...defaultProps} />);
    expect(screen.getByText("Enviar 2 itens para a cozinha")).toBeTruthy();
  });

  it("botão mostra 'Confirmar N itens' quando cozinha desabilitada", () => {
    render(<ReviewCartModal {...defaultProps} kitchenEnabled={false} />);
    expect(screen.getByText("Confirmar 2 itens")).toBeTruthy();
  });

  it("botão − chama onChangeQty com delta -1", () => {
    render(<ReviewCartModal {...defaultProps} />);
    const minusBtn = screen.getByLabelText("Diminuir Hamburguer");
    fireEvent.click(minusBtn);
    expect(defaultProps.onChangeQty).toHaveBeenCalledWith("p1{}", -1);
  });

  it("botão + chama onChangeQty com delta +1", () => {
    render(<ReviewCartModal {...defaultProps} />);
    const plusBtn = screen.getByLabelText("Aumentar Hamburguer");
    fireEvent.click(plusBtn);
    expect(defaultProps.onChangeQty).toHaveBeenCalledWith("p1{}", 1);
  });

  it("botão − desabilitado quando quantidade é 1", () => {
    const lineWithQty1 = { ...mockLine, quantity: 1 };
    render(
      <ReviewCartModal
        {...defaultProps}
        lines={{ "p1-{}": lineWithQty1 }}
        count={1}
        total={25.0}
      />
    );
    const minusBtn = screen.getByLabelText("Diminuir Hamburguer");
    expect(minusBtn.disabled).toBe(true);
  });

  it("mostra quantidade no meio dos controles", () => {
    render(<ReviewCartModal {...defaultProps} />);
    expect(screen.getByText("2")).toBeTruthy();
  });
});

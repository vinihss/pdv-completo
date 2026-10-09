import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import NewOrderModal from "./NewOrderModal.jsx";

// Mocks
vi.mock("@/entities/table", () => ({
  listTables: vi.fn(() => Promise.resolve([
    { id: "t1", number: "1", status: "free" },
    { id: "t2", number: "2", status: "occupied" },
    { id: "t3", number: "3", status: "free" },
  ])),
}));

vi.mock("@/entities/customer", () => ({
  searchCustomers: vi.fn(() => Promise.resolve([])),
  createCustomer: vi.fn(),
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

describe("NewOrderModal", () => {
  const defaultProps = {
    usesTables: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("mesas ocupadas têm aria-label correto", async () => {
    render(<NewOrderModal {...defaultProps} />);
    await vi.waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
    });
    const occupiedTable = screen.getByText("2");
    expect(occupiedTable.closest("button").getAttribute("aria-label")).toBe("Mesa 2 (ocupada)");
  });

  it("mesas livres têm aria-label correto", async () => {
    render(<NewOrderModal {...defaultProps} />);
    await vi.waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
    });
    const freeTable = screen.getByText("1");
    expect(freeTable.closest("button").getAttribute("aria-label")).toBe("Mesa 1 (livre)");
  });

  it("botões de modo têm aria-pressed", () => {
    render(<NewOrderModal {...defaultProps} />);
    const mesaBtn = screen.getByRole("button", { name: /^Mesa$/i });
    const clienteBtn = screen.getByRole("button", { name: /^Cliente$/i });
    const rotuloBtn = screen.getByRole("button", { name: /^Rótulo$/i });
    expect(mesaBtn.getAttribute("aria-pressed")).toBe("true");
    expect(clienteBtn.getAttribute("aria-pressed")).toBe("false");
    expect(rotuloBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("legenda de status aparece no modo mesa", async () => {
    render(<NewOrderModal {...defaultProps} />);
    await vi.waitFor(() => {
      expect(screen.getByText("Disponível")).toBeTruthy();
      expect(screen.getByText("Ocupada")).toBeTruthy();
    });
  });

  it("input de cliente aparece ao clicar em Cliente", async () => {
    render(<NewOrderModal {...defaultProps} />);
    const clienteBtn = screen.getByRole("button", { name: /^Cliente$/i });
    fireEvent.click(clienteBtn);
    const input = screen.getByPlaceholderText("Nome do cliente...");
    expect(input).toBeTruthy();
  });

  it("input de rótulo aparece ao clicar em Rótulo", async () => {
    render(<NewOrderModal {...defaultProps} />);
    const rotuloBtn = screen.getByRole("button", { name: /^Rótulo$/i });
    fireEvent.click(rotuloBtn);
    const input = screen.getByPlaceholderText("Ex: Comanda 12");
    expect(input).toBeTruthy();
  });

  it("mostra 'Continuar comanda' quando mesa selecionada tem comanda aberta", async () => {
    const ordersByTable = {
      "t1": { id: "order-1", tableId: "t1" },
    };
    render(<NewOrderModal {...defaultProps} ordersByTable={ordersByTable} />);
    
    // Aguarda carregamento das mesas
    await vi.waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
    });
    
    // Clica na mesa 1 (que tem comanda aberta)
    const mesa1 = screen.getByText("1");
    fireEvent.click(mesa1);
    
    // Botão deve mostrar "Continuar comanda"
    const continuarBtn = screen.getByText("Continuar comanda");
    expect(continuarBtn).toBeTruthy();
  });

  it("ao confirmar mesa com comanda aberta, chama onOpenExisting", async () => {
    const ordersByTable = {
      "t1": { id: "order-1", tableId: "t1" },
    };
    const onOpenExisting = vi.fn();
    render(
      <NewOrderModal 
        {...defaultProps} 
        ordersByTable={ordersByTable}
        onOpenExisting={onOpenExisting}
      />
    );
    
    await vi.waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
    });
    
    const mesa1 = screen.getByText("1");
    fireEvent.click(mesa1);
    
    const continuarBtn = screen.getByText("Continuar comanda");
    fireEvent.click(continuarBtn);
    
    expect(onOpenExisting).toHaveBeenCalledWith("order-1");
  });

  it("mostra indicador visual em mesas com comanda aberta", async () => {
    const ordersByTable = {
      "t1": { id: "order-1", tableId: "t1" },
    };
    render(<NewOrderModal {...defaultProps} ordersByTable={ordersByTable} />);
    
    await vi.waitFor(() => {
      const mesa1 = screen.getByText("1");
      const button = mesa1.closest("button");
      expect(button.classList.contains("bg-blue-800/50")).toBe(true);
    });
  });
});

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import OrderListScreen from "./OrderListScreen.jsx";

// Mocks de dependências
vi.mock("@/shared/lib", () => ({
  formatBRL: (v) => `R$ ${Math.round(v * 100) / 100}`,
}));

vi.mock("@/entities/order", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    formatDateTime: (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—"),
  };
});

vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  const createMockIcon = (name) => {
    const Icon = (props) => <svg data-testid={`icon-${name}`} {...props} />;
    Icon.displayName = name;
    return Icon;
  };
  return {
    ...actual,
    Search: createMockIcon("Search"),
    Plus: createMockIcon("Plus"),
    Zap: createMockIcon("Zap"),
    Check: createMockIcon("Check"),
    List: createMockIcon("List"),
    LayoutGrid: createMockIcon("LayoutGrid"),
    Grid: createMockIcon("Grid"),
    AlertTriangle: createMockIcon("AlertTriangle"),
    RefreshCw: createMockIcon("RefreshCw"),
  };
});

describe("OrderListScreen", () => {
  const defaultProps = {
    orders: [],
    loading: false,
    kitchenEnabled: true,
    usesTables: true,
    filter: "open",
    setFilter: vi.fn(),
    search: "",
    setSearch: vi.fn(),
    onOpenOrder: vi.fn(),
    onNewOrder: vi.fn(),
    onReloadAll: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("mostra contagem nos chips 'Abertas' e 'Com pronto'", () => {
    const orders = [
      {
        id: "o1",
        status: "open",
        items: [
          { id: "i1", status: "ready", unitPrice: 10, quantity: 1 },
          { id: "i2", status: "ordered", unitPrice: 5, quantity: 2 },
        ],
        openedAt: "2026-01-01T10:00:00Z",
      },
      {
        id: "o2",
        status: "open",
        items: [{ id: "i3", status: "delivered", unitPrice: 20, quantity: 1 }],
        openedAt: "2026-01-01T11:00:00Z",
      },
    ];
    render(<OrderListScreen {...defaultProps} orders={orders} />);
    expect(screen.getByText("Abertas")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy(); // openCount
    expect(screen.getByText("Com pronto")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy(); // readyCount
  });

  it("mostra resumo 'N prontos · M em preparo' no cartão", () => {
    const orders = [
      {
        id: "o1",
        status: "open",
        items: [
          { id: "i1", status: "ready", unitPrice: 10, quantity: 1 },
          { id: "i2", status: "ready", unitPrice: 15, quantity: 1 },
          { id: "i3", status: "ordered", unitPrice: 5, quantity: 2 },
        ],
        openedAt: "2026-01-01T10:00:00Z",
      },
    ];
    render(<OrderListScreen {...defaultProps} orders={orders} />);
    expect(screen.getByText("2 prontos · 1 em preparo")).toBeTruthy();
  });

  it("mostra '1 pronto para entregar' quando apenas um item pronto", () => {
    const orders = [
      {
        id: "o1",
        status: "open",
        items: [{ id: "i1", status: "ready", unitPrice: 10, quantity: 1 }],
        openedAt: "2026-01-01T10:00:00Z",
      },
    ];
    render(<OrderListScreen {...defaultProps} orders={orders} />);
    expect(screen.getByText("1 pronto para entregar")).toBeTruthy();
  });

  it("mostra 'Tudo entregue' quando todos itens entregues", () => {
    const orders = [
      {
        id: "o1",
        status: "open",
        items: [{ id: "i1", status: "delivered", unitPrice: 10, quantity: 1 }],
        openedAt: "2026-01-01T10:00:00Z",
      },
    ];
    render(<OrderListScreen {...defaultProps} orders={orders} />);
    expect(screen.getByText("Tudo entregue")).toBeTruthy();
  });

  it("sem cozinha: mostra 'N aguardando entrega'", () => {
    const orders = [
      {
        id: "o1",
        status: "open",
        items: [
          { id: "i1", status: "ordered", unitPrice: 10, quantity: 1 },
          { id: "i2", status: "ordered", unitPrice: 15, quantity: 2 },
        ],
        openedAt: "2026-01-01T10:00:00Z",
      },
    ];
    render(<OrderListScreen {...defaultProps} orders={orders} kitchenEnabled={false} />);
    expect(screen.getByText("2 aguardando entrega")).toBeTruthy();
  });

  it("alerta de >24h aparece apenas uma vez", () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const orders = [
      {
        id: "o1",
        status: "open",
        items: [{ id: "i1", status: "ordered", unitPrice: 10, quantity: 1 }],
        openedAt: oldDate,
      },
    ];
    render(<OrderListScreen {...defaultProps} orders={orders} />);
    const alerts = screen.getAllByText(/Aberta há mais de 24h/);
    expect(alerts).toHaveLength(1);
  });

  it("FAB tem aria-label 'Nova comanda'", () => {
    render(<OrderListScreen {...defaultProps} />);
    const fab = screen.getByRole("button", { name: /Nova comanda/i });
    expect(fab).toBeTruthy();
  });

  it("botão de atualizar tem title", () => {
    render(<OrderListScreen {...defaultProps} />);
    const refreshBtn = screen.getByTitle("Atualizar");
    expect(refreshBtn).toBeTruthy();
  });
});

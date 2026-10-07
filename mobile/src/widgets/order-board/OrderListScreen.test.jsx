// Board (OrderListScreen): chip ativo, card de comanda aberta abre via
// callback e busca filtra. Componente puramente presentacional — a lógica real
// de corte está em filterOrders.test.js.
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import OrderListScreen from "./OrderListScreen.jsx";

// Icons (@expo/vector-icons) quebram renders repetidos sob o renderer assíncrono
// do RNTL v14 (font glyph) — mock simples os torna o teste estável e o foco fica
// no comportamento, não no ícone.
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const Icon = (props) => React.createElement(Text, null, props.name ?? "icon");
  return { Ionicons: Icon, MaterialIcons: Icon, __esModule: true };
});

function order(partial = {}) {
  return {
    id: "o1",
    status: "open",
    tableId: "t1",
    tableNumber: 7,
    customerName: null,
    tabLabel: null,
    channel: "balcao",
    openedAt: "2026-01-01T10:00:00.000Z",
    closedAt: null,
    items: [{ id: "i1", name: "Cerveja", quantity: 2, unitPrice: 10, status: "pending" }],
    ...partial,
  };
}

const handlers = {
  onFilter: jest.fn(),
  onSearch: jest.fn(),
  onOpenOrder: jest.fn(),
  onNewOrder: jest.fn(),
  onReloadAll: jest.fn(),
};

const props = (overrides) => ({
  orders: [order()],
  loading: false,
  kitchenEnabled: false,
  usesTables: true,
  filter: "all",
  search: "",
  ...overrides,
});

describe("OrderListScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("mostra mesa, total e dispara onOpenOrder na comanda aberta", async () => {
    const { getByText } = await render(<OrderListScreen {...props()} {...handlers} />);

    expect(getByText("Mesa 7")).toBeTruthy();
    expect(getByText("R$ 20,00")).toBeTruthy();
    expect(getByText("1 item")).toBeTruthy();

    await fireEvent.press(getByText("Mesa 7"));
    expect(handlers.onOpenOrder).toHaveBeenCalledWith("o1");
  });

  it("anula o tap em comanda fechada", async () => {
    const { getByText } = await render(
      <OrderListScreen {...props({ orders: [order({ status: "closed", closedAt: "2026-01-02T10:00:00.000Z" })] })} {...handlers} />
    );

    await fireEvent.press(getByText("Mesa 7"));
    expect(handlers.onOpenOrder).not.toHaveBeenCalled();
  });

  it("chip ativo marca o filtro atual e navega para nova comanda", async () => {
    const { getByText, getByLabelText } = await render(
      <OrderListScreen {...props({ kitchenEnabled: true, filter: "ready" })} {...handlers} />
    );

    await fireEvent.press(getByText("Abertas"));
    expect(handlers.onFilter).toHaveBeenCalledWith("open");

    await fireEvent.press(getByLabelText("Nova comanda"));
    expect(handlers.onNewOrder).toHaveBeenCalled();
  });

  it("busca repassa o texto para o estado do board", async () => {
    const { getByPlaceholderText } = await render(<OrderListScreen {...props({ usesTables: false })} {...handlers} />);

    await fireEvent.changeText(getByPlaceholderText("Buscar por mesa, cliente..."), "João");
    expect(handlers.onSearch).toHaveBeenCalledWith("João");
  });

  it("estado vazio mostra a mensagem do filtro", async () => {
    const { getByText } = await render(<OrderListScreen {...props({ orders: [] })} {...handlers} />);
    expect(getByText("Nenhuma comanda encontrada.")).toBeTruthy();
  });

  it("falha sem lista mostra o erro (não o vazio) e o retry recarrega", async () => {
    const { getByText } = await render(
      <OrderListScreen {...props({ orders: [], error: new Error("boom") })} {...handlers} />
    );

    expect(getByText("Não foi possível carregar as comandas.")).toBeTruthy();
    expect(() => getByText("Nenhuma comanda encontrada.")).toThrow();

    await fireEvent.press(getByText("Tentar de novo"));
    expect(handlers.onReloadAll).toHaveBeenCalled();
  });

  it("falha com lista mantém as comandas e só avisa (com retry)", async () => {
    const { getByText } = await render(
      <OrderListScreen {...props({ orders: [order()], error: new Error("boom") })} {...handlers} />
    );

    expect(getByText("Mesa 7")).toBeTruthy();
    expect(getByText("Não foi possível atualizar a lista.")).toBeTruthy();

    await fireEvent.press(getByText("Tentar de novo"));
    expect(handlers.onReloadAll).toHaveBeenCalled();
  });
});
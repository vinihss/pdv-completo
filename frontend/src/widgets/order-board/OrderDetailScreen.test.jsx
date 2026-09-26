import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import OrderDetailScreen from "./OrderDetailScreen.jsx";

// Rede de proteção da migração: cabeçalho passou a ser o `ScreenHeader`
// (Esc volta) e a confirmação de remoção é o `ConfirmModal` compartilhado
// (card centralizado + Esc cancela), em vez dos dois blocos próprios.
const deleteItem = vi.fn();

vi.mock("@/entities/order", async (importOriginal) => ({
  ...(await importOriginal()),
  updateItemStatus: () => Promise.resolve(),
  deleteItem: (...args) => deleteItem(...args),
  closeOrder: () => Promise.resolve(),
}));
vi.mock("@/app/providers/auth", () => ({ useAuth: () => ({ storeSettings: { kitchenEnabled: false } }) }));

const order = {
  id: "o1",
  tableId: "t4",
  tableNumber: 4,
  status: "open",
  version: 1,
  items: [{ id: "i1", name: "Cerveja", quantity: 2, unitPrice: 9.5, status: "ordered", version: 1, selectedVariations: null, notes: null }],
  payments: [],
};

function setup(props = {}) {
  const onBack = vi.fn();
  const onReload = vi.fn();
  render(
    <OrderDetailScreen
      order={order}
      kitchenEnabled={false}
      onBack={onBack}
      onReload={onReload}
      showToast={() => {}}
      {...props}
    />
  );
  return { onBack, onReload };
}

describe("OrderDetailScreen", () => {
  beforeEach(() => deleteItem.mockReset().mockResolvedValue());
  afterEach(cleanup);

  it("cabeçalho com ScreenHeader: título, subtítulo e voltar à esquerda", () => {
    const { onBack } = setup();
    expect(screen.getByText("Mesa 4")).toBeTruthy();
    expect(screen.getByText("1 item · R$ 19,00")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Voltar"));
    expect(onBack).toHaveBeenCalled();
  });

  it("Esc volta para a lista", () => {
    const { onBack } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Esc com a confirmação aberta cancela em vez de voltar", async () => {
    const { onBack } = setup();
    fireEvent.click(screen.getByLabelText(/^Remover Cerveja/));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onBack).not.toHaveBeenCalled();
  });

  it("remover item pede confirmação (card) e só apaga ao confirmar", async () => {
    const { onReload } = setup();
    fireEvent.click(screen.getByLabelText(/^Remover Cerveja/));
    const dialog = screen.getByRole("alertdialog", { name: "Remover item?" });
    expect(dialog.className).not.toContain("h-full");
    expect(deleteItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(deleteItem).toHaveBeenCalledWith("o1", "i1"));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it("cancelar a confirmação não apaga o item", async () => {
    setup();
    fireEvent.click(screen.getByLabelText(/^Remover Cerveja/));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(deleteItem).not.toHaveBeenCalled();
  });
});

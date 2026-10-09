import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import AddItemScreen from "./AddItemScreen.jsx";

// Funções de rede controladas pelo teste. `vi.hoisted` é necessário porque o
// factory do `vi.mock` roda antes dos imports do módulo.
const api = vi.hoisted(() => ({
  listCategories: vi.fn(),
  listAllProducts: vi.fn(),
}));

vi.mock("@/entities/category", async (importOriginal) => ({
  ...(await importOriginal()),
  listCategories: api.listCategories,
}));
vi.mock("@/entities/product", async (importOriginal) => ({
  ...(await importOriginal()),
  listAllProducts: api.listAllProducts,
}));
vi.mock("@/app/providers/auth", async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => ({ storeSettings: { kitchenEnabled: true } }),
}));

function setup() {
  return render(
    <AddItemScreen
      order={{ id: "o1" }}
      onClose={vi.fn()}
      onConfirmed={vi.fn()}
      showToast={vi.fn()}
    />
  );
}

describe("AddItemScreen — estados do catálogo", () => {
  beforeEach(() => {
    api.listCategories.mockReset();
    api.listAllProducts.mockReset();
  });
  afterEach(cleanup);

  it("mostra 'Carregando catálogo…' enquanto a carga não termina", () => {
    api.listCategories.mockReturnValue(new Promise(() => {}));
    api.listAllProducts.mockReturnValue(new Promise(() => {}));
    setup();

    expect(screen.getByText("Carregando catálogo…")).toBeTruthy();
    expect(screen.queryByText("Nenhum produto encontrado.")).toBeNull();
  });

  it("em falha mostra o erro e 'Tentar novamente', sem catálogo vazio", async () => {
    api.listCategories.mockRejectedValue(new Error("boom"));
    api.listAllProducts.mockResolvedValue({ data: [] });
    setup();

    expect(await screen.findByText("Tentar novamente")).toBeTruthy();
    expect(screen.getByText("Não foi possível carregar o catálogo.")).toBeTruthy();
    // A falha não pode parecer catálogo vazio.
    expect(screen.queryByText("Nenhum produto encontrado.")).toBeNull();
  });

  it("'Tentar novamente' dispara uma nova carga", async () => {
    api.listCategories.mockRejectedValueOnce(new Error("boom"));
    api.listAllProducts.mockResolvedValue({ data: [] });
    setup();

    const retry = await screen.findByRole("button", { name: "Tentar novamente" });
    api.listCategories.mockResolvedValueOnce([]);
    fireEvent.click(retry);

    await waitFor(() => expect(api.listCategories).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Tentar novamente")).toBeNull();
  });

  it("destaca produto recém-adicionado com feedback visual", async () => {
    const product = {
      id: "p1",
      name: "Cerveja",
      price: 10,
      imagePath: null,
      description: "",
      variations: [],
      quantity: 100,
      trackStock: false,
    };
    api.listCategories.mockResolvedValue([]);
    api.listAllProducts.mockResolvedValue({ data: [product] });
    setup();

    const button = await screen.findByRole("button", { name: /Cerveja/i });
    
    // Antes de adicionar, não tem a classe de destaque
    expect(button.className).not.toContain("ring-2");
    expect(button.className).not.toContain("scale-105");
    
    // Ao adicionar produto
    fireEvent.click(button);
    
    // Deve ter a classe de destaque temporário
    expect(button.className).toContain("ring-2");
    expect(button.className).toContain("ring-emerald-400");
    expect(button.className).toContain("scale-105");
    
    // Após 600ms, deve remover o destaque
    await waitFor(() => {
      expect(button.className).not.toContain("scale-105");
    }, { timeout: 700 });
  });
});

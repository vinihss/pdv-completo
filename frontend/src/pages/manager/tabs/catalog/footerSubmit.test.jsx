import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import ProductModal from "./ProductModal.jsx";
import MovementModal from "../inventory/MovementModal.jsx";
import SupplierModal from "../purchase/SupplierModal.jsx";

// Regressão: o `Modal` renderiza `footer` como IRMÃO do corpo que segura o
// `<form>` (Modal.jsx: corpo rolável e rodapé são dois divs irmãos). Um
// `type="submit"`, portanto, fica fora do formulário e o clique não submete
// nada — o botão "Salvar" simplesmente não fazia nada. A correção é o atributo
// `form="<id>"` do HTML5, que devolve ao botão o vínculo com o form sem
// precisar duplicar o handler em onClick.
vi.mock("@/entities/product", () => ({
  createProduct: vi.fn(() => Promise.resolve({ id: "p1" })),
  updateProduct: vi.fn(() => Promise.resolve({ id: "p1" })),
  uploadProductImage: vi.fn(() => Promise.resolve({})),
  removeProductImage: vi.fn(() => Promise.resolve({})),
}));
vi.mock("@/entities/stock", () => ({
  createSupplier: vi.fn(() => Promise.resolve({ id: "s1" })),
  registerStockMovement: vi.fn(() => Promise.resolve({})),
}));

const productApi = () => import("@/entities/product");
const stockApi = () => import("@/entities/stock");

const COMMON = { onClose: () => {}, onSaved: async () => {}, showToast: () => {} };

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("botão do rodapé submete o formulário (atributo form)", () => {
  it("ProductModal: o botão do rodapé está ligado ao <form> e salva o produto", async () => {
    const onSaved = vi.fn();
    render(
      <ProductModal
        {...COMMON}
        onSaved={onSaved}
        categories={[{ id: "c1", name: "Cafés", active: true }]}
        kitchenGroups={[]}
        kitchenEnabled={false}
        ifoodIntegrationEnabled={false}
      />
    );

    const botao = screen.getByRole("button", { name: "Salvar" });
    const form = screen.getByRole("dialog").querySelector("form");
    expect(form).toBeTruthy();
    // O vínculo é o que faz o clique funcionar: botão -> form pelo atributo form.
    expect(botao.getAttribute("type")).toBe("submit");
    expect(botao.getAttribute("form")).toBe(form.getAttribute("id"));
    expect(form.getAttribute("id")).toBeTruthy();

    // O Field associa label e campo por id (htmlFor), então o label é o
    // seletor estável — o input de Nome não tem placeholder.
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: "Café espresso" } });
    fireEvent.change(screen.getByLabelText(/^Preço/), { target: { value: "9,90" } });
    fireEvent.change(screen.getByLabelText(/^Categoria/), { target: { value: "c1" } });

    fireEvent.click(botao);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const { createProduct } = await productApi();
    expect(createProduct).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Café espresso", categoryId: "c1" })
    );
  });

  it("ProductModal: sem nome, o rodapé valida em vez de salvar", async () => {
    const showToast = vi.fn();
    const onSaved = vi.fn();
    render(
      <ProductModal
        {...COMMON}
        onSaved={onSaved}
        showToast={showToast}
        categories={[{ id: "c1", name: "Cafés", active: true }]}
        kitchenGroups={[]}
        kitchenEnabled={false}
        ifoodIntegrationEnabled={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(showToast).toHaveBeenCalledWith("Informe o nome do produto.", "error");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("MovementModal: o botão do rodapé registra o movimento", async () => {
    const onSaved = vi.fn();
    render(<MovementModal {...COMMON} onSaved={onSaved} product={{ productId: "p1", name: "Cerveja" }} />);

    const botao = screen.getByRole("button", { name: "Registrar entrada" });
    const form = screen.getByRole("dialog").querySelector("form");
    expect(botao.getAttribute("form")).toBe(form.getAttribute("id"));

    fireEvent.change(screen.getByPlaceholderText("Ex.: 12"), { target: { value: "12" } });
    fireEvent.click(botao);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const { registerStockMovement } = await stockApi();
    expect(registerStockMovement).toHaveBeenCalledWith("p1", expect.objectContaining({ quantity: 12 }));
  });

  it("SupplierModal: o botão do rodapé cria o fornecedor", async () => {
    const onSaved = vi.fn();
    render(<SupplierModal {...COMMON} onSaved={onSaved} />);

    const botao = screen.getByRole("button", { name: "Salvar" });
    const form = screen.getByRole("dialog").querySelector("form");
    expect(botao.getAttribute("form")).toBe(form.getAttribute("id"));

    fireEvent.change(screen.getByPlaceholderText("Ex.: Distribuidora Bebidas"), {
      target: { value: "DistribuidoraSul" },
    });
    fireEvent.click(botao);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const { createSupplier } = await stockApi();
    expect(createSupplier).toHaveBeenCalledWith(expect.objectContaining({ name: "DistribuidoraSul" }));
  });
});

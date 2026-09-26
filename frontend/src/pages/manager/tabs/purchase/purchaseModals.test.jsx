import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import NewPurchaseModal from "./NewPurchaseModal.jsx";
import SupplierModal from "./SupplierModal.jsx";

// Rede de proteção da migração para o `Modal`: o build e o `tsc` não pegam
// ReferenceError de import perdido nem JSX quebrado dentro de um componente
// que só é montado em runtime (aba do gerente não entra em nenhuma tela de
// teste). Aqui os dois modais de compra montam de verdade.
vi.mock("@/entities/stock", async (importOriginal) => ({
  ...(await importOriginal()),
  createPurchase: () => Promise.resolve({ id: "p1" }),
  createSupplier: () => Promise.resolve({ id: "s1" }),
}));

describe("NewPurchaseModal", () => {
  const props = {
    suppliers: [{ id: "s1", name: "Distribuidora" }],
    products: [{ id: "p1", name: "Cerveja", trackStock: true }],
    onClose: () => {},
    onSaved: async () => {},
    showToast: () => {},
  };

  it("é um diálogo de tela cheia com total e ação no rodapé", () => {
    render(<NewPurchaseModal {...props} />);
    expect(screen.getByRole("dialog", { name: "Nova compra" })).toBeTruthy();
    expect(screen.getByText("Total da compra")).toBeTruthy();
    expect(screen.getByText("R$ 0,00")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Registrar compra/ })).toBeTruthy();
    cleanup();
  });

  it("cada linha nova traz seletor de produto, qtd, custo e lote", () => {
    render(<NewPurchaseModal {...props} />);
    // fornecedor + 1 produto na linha inicial
    expect(screen.getAllByRole("combobox").length).toBe(2);
    expect(screen.getByText("Qtd.")).toBeTruthy();
    expect(screen.getByText("Custo un.")).toBeTruthy();
    expect(screen.getByText("Lote (opcional)")).toBeTruthy();
    fireEvent.click(screen.getByText("Adicionar item"));
    expect(screen.getAllByRole("combobox").length).toBe(3);
    cleanup();
  });
});

describe("SupplierModal", () => {
  it("monta nome, telefone e CNPJ com a ação no rodapé", () => {
    render(<SupplierModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Novo fornecedor" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Ex.: Distribuidora Bebidas")).toBeTruthy();
    expect(screen.getByPlaceholderText("(11) 99999-0000")).toBeTruthy();
    expect(screen.getByText("CNPJ / CPF (opcional)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeTruthy();
    cleanup();
  });
});

import React from "react";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import CustomerModal from "./CustomerModal.jsx";

// O `CustomerModal` busca endereços via `fetch("/api/customers/:id")` no
// useEffect de edição. Em node a URL relativa é inválida pro fetch — um
// stub mínimo evita unhandled rejection sem mudar o que o teste cobre.
beforeAll(() => {
  vi.stubGlobal("fetch", (input) => {
    const id = String(input).split("/").pop();
    return Promise.resolve(new Response(JSON.stringify({ id, addresses: [] }), { status: 200 }));
  });
});
afterAll(() => vi.unstubAllGlobals());

// O `CustomerModal` só é montado em runtime pelas abas Clientes (gerente e
// caixa), então build/tsc não protegem o JSX dele. Este é o teste de
// montagem.
describe("CustomerModal", () => {
  const showToast = () => {};

  it("criação: nome, telefone, email e ação no rodapé", () => {
    render(<CustomerModal onClose={() => {}} onSaved={async () => {}} showToast={showToast} />);
    expect(screen.getByRole("dialog", { name: "Novo cliente" })).toBeTruthy();
    expect(screen.getByText("Nome")).toBeTruthy();
    expect(screen.getByText("Telefone")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Criar cliente" })).toBeTruthy();
    cleanup();
  });

  it("edição: campos preenchidos e seção de endereços", () => {
    const customer = {
      id: "c1",
      name: "Maria Silva",
      phone: "11987654321",
      email: "maria@exemplo.com",
      addresses: [
        {
          id: "a1",
          label: "Casa",
          street: "Rua das Flores",
          number: "123",
          neighborhood: "Centro",
          city: "Sao Paulo",
          isDefault: true,
        },
      ],
    };
    render(<CustomerModal customer={customer} onClose={() => {}} onSaved={async () => {}} showToast={showToast} />);
    expect(screen.getByRole("dialog", { name: "Editar cliente" })).toBeTruthy();
    expect(screen.getByDisplayValue("Maria Silva")).toBeTruthy();
    expect(screen.getByDisplayValue("(11) 98765-4321")).toBeTruthy();
    expect(screen.getByText("Endereços (1/3)")).toBeTruthy();
    expect(screen.getByText("Casa")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Adicionar endereço" })).toBeTruthy();
    cleanup();
  });
});

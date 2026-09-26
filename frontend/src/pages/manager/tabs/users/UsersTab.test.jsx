import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NewUserModal } from "./UsersTab.jsx";

// O `NewUserModal` só é montado em runtime pela aba Equipe do gerente, então
// build/tsc não protegem o JSX dele. Este é o teste de montagem.
describe("NewUserModal", () => {
  it("é um diálogo de tela cheia com nome, perfil e ação no rodapé", () => {
    render(<NewUserModal onClose={() => {}} onCreate={async () => {}} />);
    expect(screen.getByRole("dialog", { name: "Novo usuário" })).toBeTruthy();
    expect(screen.getByText("Nome")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Criar usuário" })).toBeTruthy();
    cleanup();
  });

  it("lista os 5 perfis e deixa trocar o seleção", () => {
    render(<NewUserModal onClose={() => {}} onCreate={async () => {}} />);
    const select = screen.getByRole("combobox");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Garçom",
      "Cozinha",
      "Gerente",
      "Caixa",
      "Entregador",
    ]);
    fireEvent.change(select, { target: { value: "courier" } });
    expect(select.value).toBe("courier");
    cleanup();
  });
});

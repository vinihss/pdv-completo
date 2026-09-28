import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import UserModal from "./UserModal.jsx";

// O `UserModal` só é montado em runtime pela aba Equipe do gerente, então
// build/tsc não protegem o JSX dele. Este é o teste de montagem.
describe("UserModal", () => {
  it("é um diálogo de tela cheia com nome, perfil e ação no rodapé", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Novo usuário" })).toBeTruthy();
    expect(screen.getByText("Nome")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Criar usuário" })).toBeTruthy();
    cleanup();
  });

  it("lista os 5 perfis e deixa trocar a seleção", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
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

  it("tem telefone, email e campo de PIN", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    expect(screen.getByText("Telefone")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByPlaceholderText("4 a 6 dígitos")).toBeTruthy();
    cleanup();
  });

  it("edição mostra foto do usuário e campos preenchidos", () => {
    const user = { id: "u1", name: "Ana Ribeiro", role: "waiter", phone: "11999990001", email: "ana@exemplo.com" };
    render(<UserModal user={user} onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Editar usuário" })).toBeTruthy();
    expect(screen.getByDisplayValue("Ana Ribeiro")).toBeTruthy();
    expect(screen.getByDisplayValue("(11) 99999-0001")).toBeTruthy();
    expect(screen.getByDisplayValue("ana@exemplo.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar foto" })).toBeTruthy();
    cleanup();
  });
});

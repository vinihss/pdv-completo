import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import LoginPage from "./LoginPage.jsx";

const users = [{ id: "u1", name: "Ana Ribeiro", role: "waiter" }];

vi.mock("@/entities/session", () => ({
  listLoginUsers: () => Promise.resolve(users),
}));
vi.mock("@/entities/store", () => ({
  getStoreInfo: () => Promise.resolve({ merchantName: "Bar do Zé" }),
}));

const login = vi.fn();

vi.mock("@/app/providers/auth", () => ({
  useAuth: () => ({ login }),
}));

// Entra na tela de PIN clicando no usuário da lista.
async function openPinScreen() {
  render(<LoginPage />);
  await screen.findByText("Ana Ribeiro");
  fireEvent.click(screen.getByText("Ana Ribeiro"));
  return screen.getByLabelText("PIN");
}

function typeOnKeypad(digits) {
  for (const d of digits) fireEvent.click(screen.getByText(d));
}

describe("LoginPage — PIN", () => {
  beforeEach(() => {
    login.mockReset();
    login.mockResolvedValue({ token: "t" });
  });
  afterEach(cleanup);

  it("teclado físico preenche o PIN (o listener de dígito funciona)", async () => {
    const input = await openPinScreen();
    for (const d of ["1", "2", "3", "4"]) {
      fireEvent.keyDown(window, { key: d });
    }
    expect(input.value).toBe("1234");
  });

  it("Enter envia o PIN completo", async () => {
    const input = await openPinScreen();
    typeOnKeypad("1234");
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(login).toHaveBeenCalledWith("u1", "1234"));
    expect(input.value).toBe("1234");
  });

  it("botão Entrar envia o PIN completo", async () => {
    await openPinScreen();
    typeOnKeypad("1234");
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("u1", "1234"));
  });

  it("não envia ao completar 6 dígitos — o envio é explícito", async () => {
    await openPinScreen();
    typeOnKeypad("123456");
    expect(login).not.toHaveBeenCalled();
  });

  it("Entrar fica desabilitado com menos de 4 dígitos", async () => {
    await openPinScreen();
    const button = screen.getByRole("button", { name: "Entrar" });
    typeOnKeypad("123");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(login).not.toHaveBeenCalled();
  });

  it("Enter com PIN curto não envia", async () => {
    await openPinScreen();
    typeOnKeypad("12");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(login).not.toHaveBeenCalled();
  });

  it("não duplica dígito digitado no input do celular", async () => {
    const input = await openPinScreen();
    fireEvent.change(input, { target: { value: "1234" } });
    fireEvent.keyDown(input, { key: "5" });
    expect(input.value).toBe("1234");
  });

  it("input do celular recusa não-dígitos e corta em 6", async () => {
    const input = await openPinScreen();
    fireEvent.change(input, { target: { value: "12a34" } });
    expect(input.value).toBe("1234");
    fireEvent.change(input, { target: { value: "1234567" } });
    expect(input.value).toBe("123456");
  });

  it("input do celular é numérico e aceita código de uso único", async () => {
    const input = await openPinScreen();
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
  });

  it("apagar remove o último dígito", async () => {
    const input = await openPinScreen();
    typeOnKeypad("1234");
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(input.value).toBe("123");
  });

  it("Enter não dispara dois envios", async () => {
    await openPinScreen();
    typeOnKeypad("1234");
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });

  it("PIN incorreto mostra erro e limpa o campo", async () => {
    login.mockRejectedValue({ code: "invalid_pin", message: "PIN incorreto" });
    const input = await openPinScreen();
    typeOnKeypad("9999");
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(screen.getByText("PIN incorreto. Tente novamente.")).toBeTruthy());
    expect(input.value).toBe("");
  });

  it("Esc volta para a seleção de usuário", async () => {
    await openPinScreen();
    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByText("Selecione seu nome para continuar");
  });
});

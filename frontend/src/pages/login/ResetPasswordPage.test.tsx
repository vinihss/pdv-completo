import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPassword } from "@/entities/session";
import ResetPasswordPage from "./ResetPasswordPage.jsx";

vi.mock("@/entities/session", async (orig) => ({
  ...(await orig()),
  resetPassword: vi.fn(),
}));

function renderWithToken(token) {
  render(
    <MemoryRouter initialEntries={[`/reset-password${token ? `?token=${token}` : ""}`]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Routes>
    </MemoryRouter>
  );
}

async function fillAndSubmit({ nova = "senha-nova-123", confirmacao = nova } = {}) {
  fireEvent.change(await screen.findByLabelText("Nova senha"), { target: { value: nova } });
  fireEvent.change(screen.getByLabelText("Confirmar nova senha"), {
    target: { value: confirmacao },
  });
  // act() no clique: o submit é async e a rejeição é tratada DENTRO do
  // componente (catch → mensagem), então o await descarrega o estado antes do assert.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Salvar nova senha" }));
  });
}

  // Block body OBRIGATÓRIO: no Vitest 5 o VALOR DE RETORNO de beforeEach vira
  // callback de cleanup chamado depois do teste, e mockReset() devolve o próprio
  // stub — concise arrow faria o vitest INVOCAR o mock uma 2ª vez sem aguardar
  // (rejeição viraria unhandled). Ver getBeforeHookCleanupCallback no runner.
  beforeEach(() => {
    resetPassword.mockReset();
  });
afterEach(cleanup);

describe("ResetPasswordPage — /reset-password?token=", () => {
  it("sem token na URL: avisa e não deixa salvar", () => {
    renderWithToken(null);
    expect(screen.getByText(/link de recuperação é inválido/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Salvar nova senha" }).disabled).toBe(true);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("sucesso: troca a senha e avisa para logar", async () => {
    resetPassword.mockResolvedValue({ ok: true });
    renderWithToken("tok-123");
    await fillAndSubmit();
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith("tok-123", "senha-nova-123"));
    expect(await screen.findByText("Senha redefinida")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir para o login" })).toBeTruthy();
  });

  it("senhas diferentes não chamam a API", async () => {
    renderWithToken("tok-123");
    await fillAndSubmit({ nova: "senha-nova-123", confirmacao: "outra" });
    expect(await screen.findByText(/As senhas não coincidem/)).toBeTruthy();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("token inválido/expirado (400) mostra mensagem e o link para pedir de novo", async () => {
    // async/throw em vez de mockRejectedValue ou Promise.reject eagerly: neste
    // vitest (vmThreads), promise rejeitada criada sem handler é reportada como
    // unhandled mesmo sendo tratada dentro do componente — lançar dentro de uma
    // async fn só rejeita quando o componente aguarda.
    resetPassword.mockImplementation(async () => {
      throw { status: 400, code: "invalid_token" };
    });
    renderWithToken("tok-velho");
    await fillAndSubmit();
    expect(await screen.findByText(/link de recuperação é inválido/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Solicite uma nova recuperação/ })).toBeTruthy();
  });

  it("erro de rede não culpa o link", async () => {
    resetPassword.mockImplementation(async () => {
      throw new Error("fetch failed");
    });
    renderWithToken("tok-123");
    await fillAndSubmit();
    expect(await screen.findByText(/Não foi possível salvar agora/)).toBeTruthy();
  });
});

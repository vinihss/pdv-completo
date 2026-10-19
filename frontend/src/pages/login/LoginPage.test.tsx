import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage.jsx";

// Dublês do AuthProvider de dois estágios: o fluxo novo separa a etapa de
// conta (loginNovo/changeAccountPassword) da sessão (completeTenantSelection),
// então cada teste decide o que cada estágio devolve.
const mocks = vi.hoisted(() => ({
  loginNovo: vi.fn(),
  changeAccountPassword: vi.fn(),
  completeTenantSelection: vi.fn(),
  cancelAccountStage: vi.fn(),
}));

vi.mock("@/app/providers/auth", () => ({
  useAuth: () => mocks,
}));
// Só o forgot faz rede; getDeviceTenantSlug fica REAL (lê o localStorage do
// teste — é exatamente a preferência de dispositivo docs/26 §2 decisão 6).
vi.mock("@/entities/session", async (orig) => ({
  ...(await orig()),
  forgotPassword: vi.fn(),
}));

const { forgotPassword } = await import("@/entities/session");

// LoginPage lê ?forgot=1 da URL (link "esqueci de novo" do reset), então os
// testes renderizam dentro de um Router.
function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

const BAR_DO_ZE = { slug: "bar-do-ze", name: "Bar do Zé" };
const CANTINA = { slug: "cantina-b", name: "Cantina B" };

function fillCredentials({ email = "ana@pdv.local", password = "segredo", remember = false } = {}) {
  fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Senha"), { target: { value: password } });
  // O checkbox nasce marcado (defaultChecked): "remember=false" é desmarcar.
  const checkbox = screen.getByLabelText("Lembrar de mim");
  if (checkbox.checked !== remember) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mocks.loginNovo.mockReset();
  mocks.changeAccountPassword.mockReset();
  mocks.completeTenantSelection.mockReset();
  mocks.cancelAccountStage.mockReset();
  mocks.completeTenantSelection.mockResolvedValue({ token: "t", user: { id: "u1", role: "waiter" } });
  mocks.changeAccountPassword.mockReset();
  forgotPassword.mockReset();
});
afterEach(cleanup);

describe("LoginPage — e-mail + senha", () => {
  it("envia email, senha e 'lembrar' pelo fluxo novo e entra direto com 1 empresa", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE],
    });
    renderLogin();
    fillCredentials({ remember: true });
    await waitFor(() => expect(mocks.loginNovo).toHaveBeenCalledWith("ana@pdv.local", "segredo", true));
    await waitFor(() => expect(mocks.completeTenantSelection).toHaveBeenCalledWith("bar-do-ze"));
  });

  it("credencial recusada mostra o erro genérico (não enumera conta)", async () => {
    mocks.loginNovo.mockRejectedValue({ status: 401, code: "invalid_credentials" });
    renderLogin();
    fillCredentials();
    expect(await screen.findByText("E-mail ou senha incorretos.")).toBeTruthy();
    expect(mocks.completeTenantSelection).not.toHaveBeenCalled();
  });

  it("erro de rede mostra aviso de conexão, não de credencial", async () => {
    mocks.loginNovo.mockRejectedValue(new Error("fetch failed"));
    renderLogin();
    fillCredentials();
    expect(
      await screen.findByText("Não foi possível conectar ao servidor. Tente novamente.")
    ).toBeTruthy();
  });

  it("muitas tentativas tem mensagem própria", async () => {
    mocks.loginNovo.mockRejectedValue({ status: 429, code: "too_many_attempts" });
    renderLogin();
    fillCredentials();
    expect(await screen.findByText(/Muitas tentativas/)).toBeTruthy();
  });

  it("o olho mostra e oculta a senha", async () => {
    renderLogin();
    const input = screen.getByLabelText("Senha");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByLabelText("Mostrar senha"));
    expect(screen.getByLabelText("Senha").getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByLabelText("Ocultar senha"));
    expect(screen.getByLabelText("Senha").getAttribute("type")).toBe("password");
  });

  it("sem preencher não envia", () => {
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(mocks.loginNovo).not.toHaveBeenCalled();
  });

  it("'lembrar' desmarcado vira false (terminal compartilhado)", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE],
    });
    renderLogin();
    fillCredentials({ remember: false });
    await waitFor(() => expect(mocks.loginNovo).toHaveBeenCalledWith("ana@pdv.local", "segredo", false));
  });
});

describe("LoginPage — seleção de empresa", () => {
  it("2 empresas sem preferência: mostra o grid e a escolha manual chama select-tenant", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE, CANTINA],
    });
    renderLogin();
    fillCredentials();
    expect(await screen.findByText("Escolha a empresa")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cantina B/ }));
    await waitFor(() => expect(mocks.completeTenantSelection).toHaveBeenCalledWith("cantina-b"));
  });

  it("preferência do dispositivo (pdv:tenant) seleciona automático, sem grid", async () => {
    localStorage.setItem("pdv:tenant", "cantina-b");
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE, CANTINA],
    });
    renderLogin();
    fillCredentials();
    await waitFor(() => expect(mocks.completeTenantSelection).toHaveBeenCalledWith("cantina-b"));
    expect(screen.queryByText("Escolha a empresa")).toBeNull();
  });

  it("preferência que saiu da lista não é usada: abre o grid", async () => {
    localStorage.setItem("pdv:tenant", "empresa-que-saiu");
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE, CANTINA],
    });
    renderLogin();
    fillCredentials();
    expect(await screen.findByText("Escolha a empresa")).toBeTruthy();
    expect(mocks.completeTenantSelection).not.toHaveBeenCalled();
  });

  it("sem empresa vinculada: avisa e não tenta select-tenant", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [],
    });
    renderLogin();
    fillCredentials();
    expect(
      await screen.findByText("Nenhuma empresa vinculada a esta conta. Contate o gerente.")
    ).toBeTruthy();
    expect(mocks.completeTenantSelection).not.toHaveBeenCalled();
  });

  it("select-tenant recusado (403 tenant_not_linked) mostra aviso de vínculo", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE, CANTINA],
    });
    mocks.completeTenantSelection.mockRejectedValue({ status: 403, code: "tenant_not_linked" });
    renderLogin();
    fillCredentials();
    fireEvent.click(await screen.findByRole("button", { name: /Bar do Zé/ }));
    expect(
      await screen.findByText("Você não tem mais acesso a esta empresa. Fale com o gerente.")
    ).toBeTruthy();
  });

  it("'entrar com outra conta' cancela a etapa e volta ao formulário", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE, CANTINA],
    });
    renderLogin();
    fillCredentials();
    fireEvent.click(await screen.findByRole("button", { name: "Entrar com outra conta" }));
    expect(mocks.cancelAccountStage).toHaveBeenCalled();
    expect(await screen.findByLabelText("E-mail")).toBeTruthy();
  });
});

describe("LoginPage — troca obrigatória de senha", () => {
  it("mustChangePassword leva à troca ANTES de qualquer seleção", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: true,
      companies: [BAR_DO_ZE],
    });
    renderLogin();
    fillCredentials();
    // Nem com 1 empresa ele entra direto: a troca bloqueia o select-tenant.
    expect(await screen.findByText("Crie sua senha")).toBeTruthy();
    expect(mocks.completeTenantSelection).not.toHaveBeenCalled();
  });

  it("senhas diferentes não enviam e avisam", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: true,
      companies: [BAR_DO_ZE],
    });
    renderLogin();
    fillCredentials();
    fireEvent.change(await screen.findByLabelText("Nova senha"), { target: { value: "nova123" } });
    fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: "outra123" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nova senha" }));
    expect(await screen.findByText(/As senhas não coincidem/)).toBeTruthy();
    expect(mocks.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("troca concluída segue para a seleção de empresa", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: true,
      companies: [BAR_DO_ZE, CANTINA],
    });
    mocks.changeAccountPassword.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: false,
      companies: [BAR_DO_ZE, CANTINA],
    });
    renderLogin();
    fillCredentials();
    fireEvent.change(await screen.findByLabelText("Nova senha"), { target: { value: "nova123" } });
    fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: "nova123" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nova senha" }));
    await waitFor(() => expect(mocks.changeAccountPassword).toHaveBeenCalledWith("nova123"));
    expect(await screen.findByText("Escolha a empresa")).toBeTruthy();
  });

  it("troca com sessão expirada (401) pede para entrar de novo", async () => {
    mocks.loginNovo.mockResolvedValue({
      accountToken: "acc",
      mustChangePassword: true,
      companies: [BAR_DO_ZE],
    });
    mocks.changeAccountPassword.mockRejectedValue({ status: 401 });
    renderLogin();
    fillCredentials();
    fireEvent.change(await screen.findByLabelText("Nova senha"), { target: { value: "nova123" } });
    fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: "nova123" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nova senha" }));
    expect(await screen.findByText(/Sua sessão expirou/)).toBeTruthy();
  });
});

describe("LoginPage — esqueci a senha", () => {
  it("confirmação é genérica: nunca diz se o e-mail existe", async () => {
    forgotPassword.mockResolvedValue({ ok: true });
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "Esqueci a senha" }));
    fireEvent.change(await screen.findByLabelText("E-mail da conta"), {
      target: { value: "ana@pdv.local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar instruções" }));
    await waitFor(() => expect(forgotPassword).toHaveBeenCalledWith("ana@pdv.local"));
    expect(await screen.findByText(/Se houver uma conta com este e-mail/)).toBeTruthy();
  });

  it("sem SMTP (503 email_not_configured) mostra aviso amigável", async () => {
    forgotPassword.mockRejectedValue({ status: 503, code: "email_not_configured" });
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "Esqueci a senha" }));
    fireEvent.change(await screen.findByLabelText("E-mail da conta"), {
      target: { value: "ana@pdv.local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar instruções" }));
    expect(
      await screen.findByText(/A recuperação de senha por e-mail ainda não está configurada/)
    ).toBeTruthy();
  });
});

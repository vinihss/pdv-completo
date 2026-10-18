import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: null }));

// As páginas são desenhadas por um item só de menu cada: o que este arquivo
// testa é a casca (header + coluna do menu + tela do papel), não o conteúdo.
vi.mock("@/pages/pdv", () => ({ PdvPage: () => <p>tela: garçom</p> }));
vi.mock("@/pages/manager", () => ({ ManagerApp: () => <p>tela: gerente</p> }));
vi.mock("@/pages/kitchen", () => ({ KitchenDisplay: () => <p>tela: cozinha</p> }));
vi.mock("@/pages/courier", () => ({ CourierApp: () => <p>tela: entregador</p> }));
vi.mock("@/pages/cashier", () => ({ CashierApp: () => <p>tela: caixa</p> }));
vi.mock("@/pages/login", () => ({
  LoginPage: () => <p>tela: login</p>,
  LoginPagePin: () => <p>tela: login pin</p>,
  ResetPasswordPage: () => <p>tela: reset</p>,
}));
vi.mock("@/pages/customer-menu", () => ({ CustomerMenuPage: () => <p>tela: público</p> }));
vi.mock("@/app/providers/auth", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => mocks.auth,
}));
vi.mock("@/shared/hooks", async (orig) => ({ ...(await orig()), useRealtime: () => {} }));

const { AppFrame, AppRouter, Root } = await import("./router.jsx");

function session(role) {
  mocks.auth = {
    session: { token: "t", user: { id: "u1", name: "Ana Ribeiro", role } },
    storeSettings: { merchantName: "Unami" },
    booting: false,
    logout: vi.fn(),
  };
}

describe("AppFrame", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  // As telas entram por React.lazy: o assert espera o módulo resolver
  // (findByText) em vez de assumir render síncrono.
  it("header com logo, nome e menu do usuário, e a tela do papel ao lado do menu", async () => {
    session("waiter");
    const { container } = render(
      <MemoryRouter>
        <Root />
      </MemoryRouter>
    );
    expect(screen.getByText("Unami")).toBeTruthy();
    // O header não tem mais a foto do usuário nem o menu flutuante:
    // o perfil e o logout agora ficam no rodapé do menu lateral.
    expect(screen.queryByLabelText("Menu do usuário")).toBeNull();
    expect(await screen.findByText("tela: garçom")).toBeTruthy();
    // Garçom tem 1 item de menu: o AppMenu (e o `aside`) não é desenhado —
    // só o `main` ocupa a largura (regra de menu único, veja AppMenu/router).
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector("main")).toBeTruthy();
    expect(container.querySelector("main").className).toContain("flex-1");
  });

  it("perfil de tela única (waiter): logout fica no header, sem menu lateral", () => {
    session("waiter");
    render(
      <MemoryRouter>
        <Root />
      </MemoryRouter>
    );
    // Waiter tem 1 item de menu: não há rodapé de menu, então o logout
    // permanece no header (ícone de sair à direita).
    expect(screen.getByLabelText("Sair")).toBeTruthy();
    expect(screen.getByTitle("Sair")).toBeTruthy();
  });

  it("perfil com menu lateral (manager): logout fica no rodapé do menu, não no header", () => {
    session("manager");
    const { container } = render(
      <MemoryRouter>
        <Root />
      </MemoryRouter>
    );
    // Manager tem menu lateral: o logout está no rodapé, não no header.
    const header = container.querySelector("header, .sticky");
    expect(within(header).queryByLabelText("Sair")).toBeNull();
    expect(within(header).queryByTitle("Sair")).toBeNull();
    // Mas o rodapé do menu lateral tem o logout.
    const aside = container.querySelector("aside");
    expect(within(aside).getByLabelText("Sair")).toBeTruthy();
  });

  it("o header é h-14 e a coluna do menu começa logo abaixo dele", () => {
    session("manager");
    const { container } = render(
      <MemoryRouter>
        <Root />
      </MemoryRouter>
    );
    expect(container.querySelector("header, .sticky")?.className).toContain("h-14")
    expect(container.querySelector("aside").className).toContain("top-14")
  });

  it("botão de menu abre o painel e escolher a tela fecha", async () => {
    session("cashier");
    render(
      <MemoryRouter>
        <Root />
      </MemoryRouter>
    );
    const botao = screen.getByLabelText("Abrir menu");
    expect(botao.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(botao);
    const painel = within(screen.getByRole("dialog"));
    expect(botao.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(painel.getByRole("button", { name: "Caixa" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("tela: caixa")).toBeTruthy();
  });

  it("cada papel cai na sua tela", async () => {
    for (const [role, texto] of [
      ["manager", "tela: gerente"],
      ["kitchen", "tela: cozinha"],
      ["courier", "tela: entregador"],
      ["cashier", "tela: caixa"],
      ["waiter", "tela: garçom"],
    ]) {
      session(role);
      const { unmount } = render(
        <MemoryRouter>
          <Root />
        </MemoryRouter>
      );
      expect(await screen.findByText(texto)).toBeTruthy();
      unmount();
    }
  });

  it("sem sessão, mostra o login — e nenhuma tela nem menu", async () => {
    mocks.auth = { session: null, booting: false, storeSettings: null };
    const { container } = render(
      <MemoryRouter>
        <Root />
      </MemoryRouter>
    );
    expect(await screen.findByText("tela: login")).toBeTruthy();
    expect(container.querySelector("aside")).toBeNull();
  });

  // A casca depende dos três providers (menu, sino e foco de comanda) — os três
  // guardam estado que atravessa casca↔página, então nenhum pode ser prop.
  it("AppFrame isolado também funciona, desde que dentro dos três providers", async () => {
    const { NavProvider } = await import("@/app/providers/nav");
    const { AlertsProvider } = await import("@/app/providers/alerts");
    const { OrderFocusProvider } = await import("@/app/providers/order-focus");
    session("manager");
    render(
      <MemoryRouter>
        <NavProvider role="manager">
          <AlertsProvider>
            <OrderFocusProvider>
              <AppFrame>
                <p>conteúdo</p>
              </AppFrame>
            </OrderFocusProvider>
          </AlertsProvider>
        </NavProvider>
      </MemoryRouter>
    );
    expect(screen.getByText("conteúdo")).toBeTruthy();
    expect(screen.getByText("Ana Ribeiro")).toBeTruthy();
  });
});

// Rotas públicas da identidade centralizada (docs/26 §5): o reset-password é
// link de e-mail (não tem sessão) e o /login/pin é o fallback histórico.
// Renderizam o AppRouter de verdade (history do jsdom), fora do AppFrame.
describe("rotas públicas de identidade", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.history.pushState({}, "", "/");
  });
  afterEach(cleanup);

  it("/reset-password é pública: renderiza a tela de reset sem sessão", async () => {
    mocks.auth = { session: null, booting: false, storeSettings: null };
    window.history.pushState({}, "", "/reset-password?token=abc");
    render(<AppRouter />);
    expect(await screen.findByText("tela: reset")).toBeTruthy();
  });

  it("/login/pin sem sessão abre o fallback de PIN", async () => {
    mocks.auth = { session: null, booting: false, storeSettings: null };
    window.history.pushState({}, "", "/login/pin");
    render(<AppRouter />);
    expect(await screen.findByText("tela: login pin")).toBeTruthy();
  });

  it("/login/pin com sessão manda para a tela do papel", async () => {
    session("waiter");
    window.history.pushState({}, "", "/login/pin");
    render(<AppRouter />);
    expect(await screen.findByText("tela: garçom")).toBeTruthy();
  });

  it("rota desconhecida sem sessão cai no login novo", async () => {
    mocks.auth = { session: null, booting: false, storeSettings: null };
    window.history.pushState({}, "", "/qualquer-coisa");
    render(<AppRouter />);
    expect(await screen.findByText("tela: login")).toBeTruthy();
  });
});

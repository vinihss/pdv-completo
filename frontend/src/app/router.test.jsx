import React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: null }));

// As páginas são desenhadas por um item só de menu cada: o que este arquivo
// testa é a casca (header + coluna do menu + tela do papel), não o conteúdo.
vi.mock("@/pages/pdv", () => ({ PdvPage: () => <p>tela: garçom</p> }));
vi.mock("@/pages/manager", () => ({ ManagerApp: () => <p>tela: gerente</p> }));
vi.mock("@/pages/kitchen", () => ({ KitchenDisplay: () => <p>tela: cozinha</p> }));
vi.mock("@/pages/courier", () => ({ CourierApp: () => <p>tela: entregador</p> }));
vi.mock("@/pages/cashier", () => ({ CashierApp: () => <p>tela: caixa</p> }));
vi.mock("@/pages/login", () => ({ LoginPage: () => <p>tela: login</p> }));
vi.mock("@/pages/customer-menu", () => ({ CustomerMenuPage: () => <p>tela: público</p> }));
vi.mock("@/app/providers/auth", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => mocks.auth,
}));
vi.mock("@/shared/hooks", async (orig) => ({ ...(await orig()), useRealtime: () => {} }));

const { AppFrame, Root } = await import("./router.jsx");

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

  it("header com logo, nome e saída, e a tela do papel ao lado do menu", () => {
    session("waiter");
    const { container } = render(
      <Root />
    );
    expect(screen.getByText("Unami")).toBeTruthy();
    expect(screen.getByLabelText("Trocar usuário")).toBeTruthy();
    expect(screen.getByText("tela: garçom")).toBeTruthy();
    // Coluna do menu à esquerda, conteúdo no resto da largura.
    expect(container.querySelector("aside")).toBeTruthy();
    expect(container.querySelector("main")).toBeTruthy();
    expect(container.querySelector("main").className).toContain("flex-1");
  });

  it("o header é h-14 e a coluna do menu começa logo abaixo dele", () => {
    session("manager");
    const { container } = render(<Root />);
    expect(container.querySelector("header, .sticky")?.className).toContain("h-14");
    expect(container.querySelector("aside").className).toContain("top-14");
  });

  it("botão de menu abre o painel e escolher a tela fecha", () => {
    session("cashier");
    render(<Root />);
    const botao = screen.getByLabelText("Abrir menu");
    expect(botao.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(botao);
    const painel = within(screen.getByRole("dialog"));
    expect(botao.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(painel.getByRole("button", { name: "Caixa" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("tela: caixa")).toBeTruthy();
  });

  it("cada papel cai na sua tela", () => {
    for (const [role, texto] of [
      ["manager", "tela: gerente"],
      ["kitchen", "tela: cozinha"],
      ["courier", "tela: entregador"],
      ["cashier", "tela: caixa"],
      ["waiter", "tela: garçom"],
    ]) {
      session(role);
      const { unmount } = render(<Root />);
      expect(screen.getByText(texto)).toBeTruthy();
      unmount();
    }
  });

  it("sem sessão, mostra o login — e nenhuma tela nem menu", () => {
    mocks.auth = { session: null, booting: false, storeSettings: null };
    const { container } = render(<Root />);
    expect(screen.getByText("tela: login")).toBeTruthy();
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
      <NavProvider role="manager">
        <AlertsProvider>
          <OrderFocusProvider>
            <AppFrame>
              <p>conteúdo</p>
            </AppFrame>
          </OrderFocusProvider>
        </AlertsProvider>
      </NavProvider>
    );
    expect(screen.getByText("conteúdo")).toBeTruthy();
    expect(screen.getByText("Ana Ribeiro")).toBeTruthy();
  });
});

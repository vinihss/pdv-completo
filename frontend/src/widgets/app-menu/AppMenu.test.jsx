import React from "react";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: null, lowCount: 0 }));

vi.mock("@/app/providers/auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/entities/stock", () => ({ useLowStockCount: () => mocks.lowCount }));

const { default: AppMenu } = await import("./AppMenu.jsx");
const { NavProvider, useNav } = await import("@/app/providers/nav");

function loggedIn(role, storeSettings = {}, photoPath = null) {
  mocks.auth = { session: { token: "t", user: { id: "u1", name: "Roberto Alves", role, photoPath } }, storeSettings, logout: vi.fn() };
}

/** O botão de abrir mora no header (casca); aqui um botão equivalente. */
function Harness() {
  const { openDrawer } = useNav();
  return (
    <>
      <button onClick={openDrawer}>abrir</button>
      <AppMenu />
    </>
  );
}

function setup(role, storeSettings, photoPath) {
  loggedIn(role, storeSettings, photoPath);
  return render(
    <NavProvider role={role}>
      <Harness />
    </NavProvider>
  );
}

const asideOf = (container) => within(container.querySelector("aside"));

describe("AppMenu", () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.lowCount = 0;
  });
  afterEach(cleanup);

  it("gerente: coluna completa, seção da tela ativa aberta", () => {
    const { container } = setup("manager", { inventoryEnabled: true, purchaseEnabled: true });
    const aside = asideOf(container);
    expect(container.querySelector("aside").className).toContain("w-72");
    // Seções com mais de um item viram cabeçalho expansível.
    for (const label of ["Operação", "Catálogo", "Gestão"]) {
      expect(aside.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    // Sem tela guardada: começa em Comandas, com a seção Operação aberta.
    expect(aside.getByRole("button", { name: /Operação/ }).getAttribute("aria-expanded")).toBe("true");
    expect(aside.getByText("Comandas").closest("button").getAttribute("aria-current")).toBe("page");
    expect(aside.queryByText("Equipe")).toBeNull();
  });

  it("seção de um item só não vira cabeçalho (nada de 'Configurações' dentro de 'Sistema')", () => {
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    expect(aside.queryByRole("button", { name: /Sistema/ })).toBeNull();
    expect(aside.queryByRole("button", { name: /Catálogo/ })).toBeNull(); // só Cadastros
    expect(aside.getByText("Configurações")).toBeTruthy();
    expect(aside.getByText("Cadastros")).toBeTruthy();
  });

  it("gerente: Estoque e Compras só entram com os toggles", () => {
    const sem = setup("manager", {});
    const aside = asideOf(sem.container);
    expect(aside.queryByText("Estoque")).toBeNull();
    expect(aside.queryByText("Compras")).toBeNull();
    cleanup();

    const com = setup("manager", { inventoryEnabled: true, purchaseEnabled: true });
    const outra = asideOf(com.container);
    fireEvent.click(outra.getByRole("button", { name: /Catálogo/ }));
    expect(outra.getByText("Estoque")).toBeTruthy();
    expect(outra.getByText("Compras")).toBeTruthy();
  });

  it("iFood só entra no menu com a integração ligada; WhatsApp não é item de menu", () => {
    const sem = setup("manager", {});
    expect(asideOf(sem.container).queryByText("iFood")).toBeNull();
    expect(asideOf(sem.container).queryByText("WhatsApp")).toBeNull();
    cleanup();

    const com = setup("manager", { ifoodIntegrationEnabled: true });
    const aside = asideOf(com.container);
    // Operação já vem aberta: a tela inicial é Comandas.
    expect(aside.getByText("iFood")).toBeTruthy();
    expect(aside.queryByText("WhatsApp")).toBeNull();
  });

  it("abrir outra seção mostra os itens dela sem fechar a primeira", () => {
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    fireEvent.click(aside.getByRole("button", { name: /Gestão/ }));
    expect(aside.getByRole("button", { name: /Gestão/ }).getAttribute("aria-expanded")).toBe("true");
    expect(aside.getByRole("button", { name: /Operação/ }).getAttribute("aria-expanded")).toBe("true");
    expect(aside.getByText("Relatórios")).toBeTruthy();
  });

  it("escolher um item troca a tela e guarda a escolha", () => {
    const { container } = setup("manager", {});
    fireEvent.click(asideOf(container).getByRole("button", { name: /Gestão/ }));
    fireEvent.click(asideOf(container).getByText("Relatórios"));
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("reports");
    cleanup();

    // Recarregar abre direto na seção da tela guardada.
    const outra = setup("manager", {});
    expect(asideOf(outra.container).getByRole("button", { name: /Gestão/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("tela guardada que não existe mais cai no primeiro item", () => {
    sessionStorage.setItem("pdv:nav:manager", "compras");
    const { container } = setup("manager", {}); // compras desligado
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("orders");
    expect(asideOf(container).getByText("Comandas").closest("button").getAttribute("aria-current")).toBe("page");
  });

  it("perfil de tela única: trilho de 64px, sem seções", () => {
    const { container } = setup("courier");
    expect(container.querySelector("aside").className).toContain("w-16");
    expect(container.querySelector("aside").className).not.toContain("w-72");
    const aside = asideOf(container);
    expect(aside.getByTitle("Entregas")).toBeTruthy();
    expect(aside.queryByRole("button", { name: /Operação/ })).toBeNull();
  });

  it("caixa tem duas telas: coluna de 72px com Caixa e Clientes", () => {
    const { container } = setup("cashier");
    expect(container.querySelector("aside").className).toContain("w-72");
    const aside = asideOf(container);
    expect(aside.getByRole("button", { name: "Caixa" })).toBeTruthy();
    expect(aside.getByRole("button", { name: "Clientes" })).toBeTruthy();
  });

  it("mostra quem está logado no rodapé (e não no trilho)", () => {
    const gerente = setup("manager");
    expect(asideOf(gerente.container).getByText("Roberto Alves")).toBeTruthy();
    cleanup();
    const caixa = setup("courier");
    expect(asideOf(caixa.container).queryByText("Roberto Alves")).toBeNull();
  });

  it("a identidade mostra a foto de quem está logado (a sessão carrega photoPath)", () => {
    const { container } = setup("manager", {}, "/uploads/u1.png");
    expect(asideOf(container).getByAltText("Roberto Alves").getAttribute("src")).toBe("/uploads/u1.png");
  });

  it("sem foto, a identidade cai nas iniciais", () => {
    const { container } = setup("manager");
    expect(asideOf(container).getByText("RA")).toBeTruthy();
  });

  it("badge de estoque baixo no item Estoque e no cabeçalho da seção", () => {
    mocks.lowCount = 3;
    const { container } = setup("manager", { inventoryEnabled: true });
    const aside = asideOf(container);
    // Recolhida: só o cabeçalho de Catálogo mostra o sinal.
    expect(within(aside.getByRole("button", { name: /Catálogo/ })).getByText("3")).toBeTruthy();
    fireEvent.click(aside.getByRole("button", { name: /Catálogo/ }));
    expect(aside.getByText("Estoque")).toBeTruthy();
    expect(within(aside.getByText("Estoque").closest("button")).getByText("3")).toBeTruthy();
  });

  it("no celular o menu vira painel inteiro, sem repetir o 'Sair' do header", () => {
    const { container } = setup("courier");
    fireEvent.click(screen.getByText("abrir"));
    const painel = within(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Menu principal");
    expect(painel.getByTitle("Entregas")).toBeTruthy();
    expect(painel.getByText("Roberto Alves")).toBeTruthy();
    // O "Sair" mora no canto do header (o scrim do painel o cobre), então o
    // rodapé do painel é só a identidade.
    expect(painel.queryByText("Trocar usuário")).toBeNull();
    // O botão do header é quem abre; a coluna do desktop segue no lugar.
    expect(container.querySelector("aside")).toBeTruthy();
  });

  it("escolher uma tela no painel fecha o painel", () => {
    setup("courier");
    fireEvent.click(screen.getByText("abrir"));
    fireEvent.click(within(screen.getByRole("dialog")).getByTitle("Entregas"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

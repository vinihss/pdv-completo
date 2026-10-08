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

  it("gerente: coluna completa e Home ativa na primeira visita", () => {
    const { container } = setup("manager", { inventoryEnabled: true, purchaseEnabled: true });
    const aside = asideOf(container);
    expect(container.querySelector("aside").className).toContain("w-72");
    // Seções com mais de um item viram cabeçalho expansível.
    for (const label of ["Operação", "Catálogo", "Gestão"]) {
      expect(aside.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    // Sem tela guardada: começa na Home; Comandas continua na seção Operação.
    expect(aside.getByText("Início").closest("button").getAttribute("aria-current")).toBe("page");
    expect(aside.getByRole("button", { name: /Operação/ }).getAttribute("aria-expanded")).toBe("false");
    expect(aside.queryByText("Comandas")).toBeNull();
    expect(aside.queryByText("Equipe")).toBeNull();
  });

  it("migra o antigo padrão Comandas para Home uma vez e depois respeita a seleção manual", () => {
    sessionStorage.setItem("pdv:nav:manager", "orders");
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("home");
    expect(aside.getByText("Início").closest("button").getAttribute("aria-current")).toBe("page");

    fireEvent.click(aside.getByRole("button", { name: /Operação/ }));
    fireEvent.click(aside.getByText("Comandas"));
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("orders");
    cleanup();

    const next = setup("manager", {});
    const nextAside = asideOf(next.container);
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("orders");
    expect(nextAside.getByText("Comandas").closest("button").getAttribute("aria-current")).toBe("page");
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
    // iFood aparece ao abrir Operação, independentemente da tela inicial.
    fireEvent.click(aside.getByRole("button", { name: /Operação/ }));
    expect(aside.getByText("iFood")).toBeTruthy();
    expect(aside.queryByText("WhatsApp")).toBeNull();
  });

  it("abrir outra seção mostra os itens dela sem fechar a primeira", () => {
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    fireEvent.click(aside.getByRole("button", { name: /Operação/ }));
    fireEvent.click(aside.getByRole("button", { name: /Gestão/ }));
    expect(aside.getByRole("button", { name: /Gestão/ }).getAttribute("aria-expanded")).toBe("true");
    expect(aside.getByRole("button", { name: /Operação/ }).getAttribute("aria-expanded")).toBe("true");
    expect(aside.getByText("Relatórios")).toBeTruthy();
  });

  it("escolher um item troca a tela e guarda a escolha", () => {
    const { container } = setup("manager", {});
    fireEvent.click(asideOf(container).getByRole("button", { name: /Gestão/ }));
    fireEvent.click(asideOf(container).getByText("Auditoria"));
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("audit");
    cleanup();

    // Recarregar abre direto na seção da tela guardada.
    const outra = setup("manager", {});
    expect(asideOf(outra.container).getByRole("button", { name: /Gestão/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("Relatórios é um grupo: o clique abre o submenu, e só o filho navega", () => {
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    fireEvent.click(aside.getByRole("button", { name: /Gestão/ }));

    const pai = aside.getByRole("button", { name: /Relatórios/ });
    expect(pai.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pai);
    // Abrir o grupo não pode escolher tela nenhuma — não há relatório "Relatórios".
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("home");

    // "Entregas" também é item da seção Operação, então a busca fica dentro do
    // grupo do submenu — senão o teste passa a depender de qual nome duplicado na tela.
    const sub = within(aside.getByRole("group", { name: "Relatórios" }));
    for (const label of ["Visão geral", "Pedidos", "Entregas", "Fluxo de caixa"]) {
      expect(sub.getByText(label)).toBeTruthy();
    }

    fireEvent.click(sub.getByText("Pedidos"));
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("reports.orders");
  });

  it("tela guardada de submenu abre Gestão E o submenu de Relatórios", () => {
    sessionStorage.setItem("pdv:nav:manager", "reports.deliveries");
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    expect(aside.getByRole("button", { name: /Gestão/ }).getAttribute("aria-expanded")).toBe("true");
    expect(aside.getByRole("button", { name: /Relatórios/ }).getAttribute("aria-expanded")).toBe("true");
    // O filho ativo marca o item; o pai fica destacado para o usuário saber
    // em qual grupo ele está.
    const sub = within(aside.getByRole("group", { name: "Relatórios" }));
    expect(sub.getByText("Entregas").closest("button").getAttribute("aria-current")).toBe("page");
  });

  it("tela guardada que não existe mais cai no primeiro item", () => {
    sessionStorage.setItem("pdv:nav:manager", "compras");
    const { container } = setup("manager", {}); // compras desligado
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("home");
    expect(asideOf(container).getByText("Início").closest("button").getAttribute("aria-current")).toBe("page");
  });

  it("perfil de tela única (courier): o menu inteiro some — nem trilho nem seções", () => {
    const { container } = setup("courier");
    // Um item só não justifica 288px (nem 64px): o AppMenu devolve null.
    expect(container.querySelector("aside")).toBeNull();
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
    // Perfil de tela única não tem coluna nenhuma (menu escondido).
    const courier = setup("courier");
    expect(courier.container.querySelector("aside")).toBeNull();
    expect(screen.queryByText("Roberto Alves")).toBeNull();
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
    // Caixa tem 2 itens → tem menu (coluna + painel). Courier (1 item) não tem.
    const { container } = setup("cashier");
    fireEvent.click(screen.getByText("abrir"));
    const painel = within(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Menu principal");
    expect(painel.getByRole("button", { name: "Caixa" })).toBeTruthy();
    expect(painel.getByText("Roberto Alves")).toBeTruthy();
    // O "Sair" mora no canto do header (o scrim do painel o cobre), então o
    // rodapé do painel é só a identidade.
    expect(painel.queryByText("Trocar usuário")).toBeNull();
    // O botão do header é quem abre; a coluna do desktop segue no lugar.
    expect(container.querySelector("aside")).toBeTruthy();
  });

  it("perfil de tela única não abre painel no celular (não há o que escolher)", () => {
    setup("courier");
    fireEvent.click(screen.getByText("abrir"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("escolher uma tela no painel fecha o painel", () => {
    setup("cashier");
    fireEvent.click(screen.getByText("abrir"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clientes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

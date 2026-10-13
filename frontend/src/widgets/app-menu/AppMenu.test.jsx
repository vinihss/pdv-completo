import React from "react";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
    <MemoryRouter>
      <NavProvider role={role}>
        <Harness />
      </NavProvider>
    </MemoryRouter>
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
    // Seções com mais de um item viram cabeçalho (label não-clicável).
    for (const label of ["Operação", "Catálogo", "Gestão"]) {
      expect(aside.getByText(label)).toBeTruthy();
    }
    // Sem tela guardada: começa na Home; todas as seções estão sempre visíveis.
    expect(aside.getByText("Início").closest("button").getAttribute("aria-current")).toBe("page");
    expect(aside.getByText("Comandas")).toBeTruthy();
    expect(aside.getByText("Equipe")).toBeTruthy();
  });

  it("migra o antigo padrão Comandas para Home uma vez e depois respeita a seleção manual", () => {
    sessionStorage.setItem("pdv:nav:manager", "orders");
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("home");
    expect(aside.getByText("Início").closest("button").getAttribute("aria-current")).toBe("page");

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
    expect(aside.getByText("iFood")).toBeTruthy();
    expect(aside.queryByText("WhatsApp")).toBeNull();
  });

  it("todas as seções estão sempre visíveis simultaneamente", () => {
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    expect(aside.getByText("Comandas")).toBeTruthy();
    expect(aside.getByText("Caixa")).toBeTruthy();
    expect(aside.getByText("Equipe")).toBeTruthy();
    expect(aside.getByText("Relatórios")).toBeTruthy();
  });

  it("escolher um item troca a tela e guarda a escolha", () => {
    const { container } = setup("manager", {});
    fireEvent.click(asideOf(container).getByText("Auditoria"));
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("audit");
    cleanup();

    // Recarrega e a tela guardada continua ativa.
    const outra = setup("manager", {});
    expect(asideOf(outra.container).getByText("Auditoria").closest("button").getAttribute("aria-current")).toBe("page");
  });

  it("Relatórios é um grupo: o submenu está sempre visível, e só o filho navega", () => {
    const { container } = setup("manager", {});
    const aside = asideOf(container);

    // O submenu está sempre visível — sem clique para abrir.
    const sub = within(aside.getByRole("group", { name: "Relatórios" }));
    for (const label of ["Visão geral", "Pedidos", "Entregas", "Fluxo de caixa"]) {
      expect(sub.getByText(label)).toBeTruthy();
    }

    fireEvent.click(sub.getByText("Pedidos"));
    expect(sessionStorage.getItem("pdv:nav:manager")).toBe("reports.orders");
  });

  it("tela guardada de submenu marca o filho ativo e destaca o pai", () => {
    sessionStorage.setItem("pdv:nav:manager", "reports.deliveries");
    const { container } = setup("manager", {});
    const aside = asideOf(container);
    // O filho ativo marca o item; o pai fica destacado para o usuário saber
    // em qual grupo ele está.
    const sub = within(aside.getByRole("group", { name: "Relatórios" }));
    expect(sub.getByText("Entregas").closest("button").getAttribute("aria-current")).toBe("page");
    expect(aside.getByText("Relatórios").closest("div").getAttribute("aria-current")).toBe("true");
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

  it("clicar na foto do rodapé abre o perfil do usuário", () => {
    const { container } = setup("manager");
    const foto = asideOf(container).getByRole("button", { name: "Meu perfil" });
    fireEvent.click(foto);
    // A navegação para /manager/profile é feita via useNavigate.
    // O MemoryRouter envolve o teste; a rota ativa muda para /manager/profile.
    expect(screen.getByRole("button", { name: "Meu perfil" })).toBeTruthy();
  });

  it("clicar no ícone de sair faz logout do usuário", () => {
    setup("manager");
    const sair = screen.getByRole("button", { name: "Sair" });
    fireEvent.click(sair);
    // O mock de logout é vi.fn(); chamadas são registradas.
    expect(mocks.auth.logout).toHaveBeenCalledTimes(1);
  });

  it("badge de estoque baixo no item Estoque e no cabeçalho da seção", () => {
    mocks.lowCount = 3;
    const { container } = setup("manager", { inventoryEnabled: true });
    const aside = asideOf(container);
    // O total continua visível no cabeçalho.
    expect(within(aside.getByText("Catálogo").closest("div")).getByText("3")).toBeTruthy();
    expect(aside.getByText("Estoque")).toBeTruthy();
    expect(within(aside.getByText("Estoque").closest("button")).getByText("3")).toBeTruthy();
  });

  it("no celular o menu vira painel inteiro, com identidade e logout no rodapé", () => {
    // Caixa tem 2 itens → tem menu (coluna + painel). Courier (1 item) não tem.
    const { container } = setup("cashier");
    fireEvent.click(screen.getByText("abrir"));
    const painel = within(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Menu principal");
    expect(painel.getByRole("button", { name: "Caixa" })).toBeTruthy();
    expect(painel.getByText("Roberto Alves")).toBeTruthy();
    // O rodapé do painel tem a identidade (foto + nome) e o logout.
    expect(painel.getByRole("button", { name: "Meu perfil" })).toBeTruthy();
    expect(painel.getByRole("button", { name: "Sair" })).toBeTruthy();
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

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BarChart3, Package, Receipt, Settings, Users, Wallet } from "lucide-react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccordionMenu from "./AccordionMenu.jsx";

const SECTIONS = [
  {
    id: "operacao",
    label: "Operação",
    icon: Receipt,
    items: [
      { id: "orders", label: "Comandas", icon: Receipt },
      { id: "cash", label: "Caixa", icon: Wallet },
    ],
  },
  {
    id: "gestao",
    label: "Gestão",
    icon: Users,
    items: [
      { id: "users", label: "Equipe", icon: Users },
      { id: "reports", label: "Relatórios", icon: BarChart3 },
    ],
  },
  {
    id: "sistema",
    label: "Sistema",
    icon: Settings,
    items: [{ id: "settings", label: "Configurações", icon: Settings }],
  },
];

function setup(props = {}) {
  const onSelect = vi.fn();
  const { rerender } = render(
    <AccordionMenu sections={SECTIONS} activeId="orders" onSelect={onSelect} {...props} />
  );
  return { onSelect, rerender };
}

describe("AccordionMenu", () => {
  afterEach(cleanup);

  it("mostra todas as seções sempre expandidas", () => {
    setup();
    expect(screen.getByText("Comandas")).toBeTruthy();
    expect(screen.getByText("Caixa")).toBeTruthy();
    expect(screen.getByText("Equipe")).toBeTruthy();
    expect(screen.getByText("Relatórios")).toBeTruthy();
  });

  it("seção de um item só: o cabeçalho é o item (sem aninhar)", () => {
    const { onSelect } = setup();
    // "Sistema" tem um item só: aparece direto, sem chevron de expansão.
    expect(screen.queryByRole("button", { name: /Sistema/ })).toBeNull();
    fireEvent.click(screen.getByText("Configurações"));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("selecionar um item avisa o id e marca o ativo com aria-current", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByText("Caixa"));
    expect(onSelect).toHaveBeenCalledWith("cash");
    expect(screen.getByText("Comandas").closest("button").getAttribute("aria-current")).toBe(
      "page"
    );
    expect(screen.getByText("Caixa").closest("button").getAttribute("aria-current")).toBeNull();
  });

  it("mostra o badge do item e o soma no cabeçalho da seção", () => {
    setup({
      sections: [
        {
          id: "catalogo",
          label: "Catálogo",
          icon: Package,
          items: [
            { id: "stock", label: "Estoque", icon: Package, badge: 3 },
            { id: "compras", label: "Compras", icon: Package, badge: 1 },
          ],
        },
      ],
    });
    // O total continua visível no cabeçalho.
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("variante trilho: achata as seções em ícones com rótulo e aria-label", () => {
    const { onSelect } = setup({ variant: "rail" });
    expect(screen.queryByRole("button", { name: /Operação/ })).toBeNull();
    const comandas = screen.getByTitle("Comandas");
    expect(comandas.textContent).toContain("Comandas");
    expect(comandas.getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTitle("Caixa"));
    expect(onSelect).toHaveBeenCalledWith("cash");
  });

  it("aceita rodapé (identidade do usuário)", () => {
    setup({ footer: <p>Ana Ribeiro</p> });
    expect(screen.getByText("Ana Ribeiro")).toBeTruthy();
  });

  it("item com children: mostra os filhos sempre visíveis", () => {
    setup({
      sections: [
        {
          id: "gestao",
          label: "Gestão",
          icon: Users,
          items: [
            { id: "users", label: "Equipe", icon: Users },
            {
              id: "reports",
              label: "Relatórios",
              icon: BarChart3,
              children: [
                { id: "reports.overview", label: "Visão geral", icon: BarChart3 },
                { id: "reports.orders", label: "Pedidos", icon: BarChart3 },
              ],
            },
          ],
        },
      ],
    });
    expect(screen.getByText("Visão geral")).toBeTruthy();
    expect(screen.getByText("Pedidos")).toBeTruthy();
  });

  it("item com children: pai fica ativo quando um filho é a tela atual", () => {
    setup({
      activeId: "reports.orders",
      sections: [
        {
          id: "gestao",
          label: "Gestão",
          icon: Users,
          items: [
            { id: "users", label: "Equipe", icon: Users },
            {
              id: "reports",
              label: "Relatórios",
              icon: BarChart3,
              children: [
                { id: "reports.overview", label: "Visão geral", icon: BarChart3 },
                { id: "reports.orders", label: "Pedidos", icon: BarChart3 },
              ],
            },
          ],
        },
      ],
    });
    expect(screen.getByText("Relatórios").closest("div").getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Pedidos").closest("button").getAttribute("aria-current")).toBe("page");
  });
});

import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Receipt, Wallet, Settings, Package, Users, BarChart3 } from "lucide-react";
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
  const onToggleSection = vi.fn();
  const { rerender } = render(
    <AccordionMenu
      sections={SECTIONS}
      activeId="orders"
      onSelect={onSelect}
      expanded={new Set(["operacao"])}
      onToggleSection={onToggleSection}
      {...props}
    />
  );
  return { onSelect, onToggleSection, rerender };
}

describe("AccordionMenu", () => {
  afterEach(cleanup);

  it("abre a seção do item ativo e esconde as outras", () => {
    setup();
    expect(screen.getByRole("button", { name: /Operação/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Gestão/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Comandas")).toBeTruthy();
    expect(screen.getByText("Caixa")).toBeTruthy();
  });

  it("seção fechada não mostra os itens", () => {
    setup({ expanded: new Set() });
    expect(screen.queryByText("Comandas")).toBeNull();
  });

  it("o cabeçalho da seção alterna a expansão", () => {
    const { onToggleSection } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Operação/ }));
    expect(onToggleSection).toHaveBeenCalledWith("operacao");
  });

  it("selecionar um item avisa o id e marca o ativo com aria-current", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByText("Caixa"));
    expect(onSelect).toHaveBeenCalledWith("cash");
    expect(screen.getByText("Comandas").closest("button").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Caixa").closest("button").getAttribute("aria-current")).toBeNull();
  });

  it("seção de um item só: o cabeçalho é o item (sem aninhar)", () => {
    const { onSelect } = setup();
    // "Sistema" tem um item só: aparece direto, sem chevron de expansão.
    expect(screen.queryByRole("button", { name: /Sistema/ })).toBeNull();
    fireEvent.click(screen.getByText("Configurações"));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("mostra o badge do item e o soma no cabeçalho da seção", () => {
    setup({
      expanded: new Set(),
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
    // Seção recolhida: o total continua visível no cabeçalho.
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
});

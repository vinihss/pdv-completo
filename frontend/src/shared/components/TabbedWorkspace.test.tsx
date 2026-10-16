import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import TabbedWorkspace from "./TabbedWorkspace.jsx";

const tabs = [
  { id: "products", label: "Produtos", count: 12 },
  { id: "groups", label: "Categorias e grupos" },
];

function renderWorkspace(onTabChange = vi.fn(), activeTab = "products") {
  return render(
    <TabbedWorkspace
      id="catalog"
      title="Produtos"
      description="Gerencie o catálogo do estabelecimento."
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={onTabChange}
      actions={<button type="button">Novo produto</button>}
    >
      <div>Conteúdo da aba selecionada</div>
    </TabbedWorkspace>
  );
}

describe("TabbedWorkspace", () => {
  it("expõe cabeçalho, ação, tablist e painel ligado à aba selecionada", () => {
    renderWorkspace();

    const selectedTab = screen.getByRole("tab", { name: "Produtos" });
    const panel = screen.getByRole("tabpanel");
    expect(screen.getByRole("heading", { name: "Produtos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Novo produto" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Seções de Produtos" })).toBeTruthy();
    expect(selectedTab.getAttribute("aria-selected")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTab.id);
    expect(panel.textContent).toContain("Conteúdo da aba selecionada");
  });

  it("seleciona uma subaba pelo clique", () => {
    const onTabChange = vi.fn();
    renderWorkspace(onTabChange);

    fireEvent.click(screen.getByRole("tab", { name: "Categorias e grupos" }));
    expect(onTabChange).toHaveBeenCalledWith("groups");
  });

  it("move foco e seleção com setas, Home e End", () => {
    const onTabChange = vi.fn();
    renderWorkspace(onTabChange);
    const productsTab = screen.getByRole("tab", { name: "Produtos" });
    const groupsTab = screen.getByRole("tab", { name: "Categorias e grupos" });

    fireEvent.keyDown(productsTab, { key: "ArrowRight" });
    expect(onTabChange).toHaveBeenLastCalledWith("groups");
    expect(document.activeElement).toBe(groupsTab);

    fireEvent.keyDown(groupsTab, { key: "Home" });
    expect(onTabChange).toHaveBeenLastCalledWith("products");
    expect(document.activeElement).toBe(productsTab);
  });
});

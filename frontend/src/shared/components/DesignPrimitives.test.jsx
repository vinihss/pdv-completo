import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Button from "./Button.jsx";
import EmptyState from "./EmptyState.jsx";
import PageHeader from "./PageHeader.jsx";

afterEach(cleanup);

describe("componentes visuais compartilhados", () => {
  it("Button define tipo seguro, variante e mantém clique funcional", () => {
    const onClick = vi.fn();
    render(<Button variant="danger" onClick={onClick}>Excluir</Button>);
    const button = screen.getByRole("button", { name: "Excluir" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("bg-red-500");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("PageHeader associa título, descrição e ações em um cabeçalho semântico", () => {
    render(<PageHeader title="Caixa" description="Resumo da sessão" actions={<button>Atualizar</button>} />);
    expect(screen.getByRole("heading", { name: "Caixa" }).tagName).toBe("H1");
    expect(screen.getByText("Resumo da sessão")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Atualizar" })).toBeTruthy();
  });

  it("EmptyState apresenta mensagem e ícone decorativo sem expor ruído ao leitor de tela", () => {
    const { container } = render(<EmptyState title="Sem resultados" description="Tente outra busca." />);
    expect(screen.getByText("Sem resultados")).toBeTruthy();
    expect(screen.getByText("Tente outra busca.")).toBeTruthy();
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});

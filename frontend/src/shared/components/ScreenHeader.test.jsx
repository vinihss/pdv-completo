import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScreenHeader from "./ScreenHeader.jsx";

describe("ScreenHeader", () => {
  afterEach(cleanup);

  it("mostra título, subtítulo e o controle de voltar à esquerda", () => {
    render(<ScreenHeader title="Adicionar item" subtitle="Mesa 4" onBack={() => {}} />);
    expect(screen.getByText("Adicionar item")).toBeTruthy();
    expect(screen.getByText("Mesa 4")).toBeTruthy();
    expect(screen.getByLabelText("Voltar")).toBeTruthy();
  });

  it("usa X quando backIcon='close' e respeita o backLabel", () => {
    const onBack = vi.fn();
    render(<ScreenHeader title="Lançamento" onBack={onBack} backIcon="close" backLabel="Fechar lançamento" />);
    fireEvent.click(screen.getByLabelText("Fechar lançamento"));
    expect(onBack).toHaveBeenCalled();
  });

  it("voltar funciona no clique", () => {
    const onBack = vi.fn();
    render(<ScreenHeader title="Comanda" onBack={onBack} />);
    fireEvent.click(screen.getByLabelText("Voltar"));
    expect(onBack).toHaveBeenCalled();
  });

  it("Esc volta", () => {
    const onBack = vi.fn();
    render(<ScreenHeader title="Comanda" onBack={onBack} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Esc não volta em repetição (segurar a tecla)", () => {
    const onBack = vi.fn();
    render(<ScreenHeader title="Comanda" onBack={onBack} />);
    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("sem onBack não há botão nem Esc", () => {
    render(<ScreenHeader title="Comanda" />);
    expect(screen.queryByLabelText("Voltar")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
  });
});

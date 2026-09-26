import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VariationModal } from "@/entities/product";

const XBURGER = {
  id: "p1",
  name: "X-Burger",
  price: 28,
  description: "Pão brioche, queijo, salada e carne 150g.",
  variations: [
    { name: "Ponto da carne", options: ["Mal passado", "Ao ponto", "Bem passado"], required: true, allowMultiple: false },
    { name: "Extras", options: ["Bacon", "Ovo"], required: false, allowMultiple: true },
  ],
};

function setup(props = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<VariationModal product={XBURGER} price={XBURGER.price} onClose={onClose} onConfirm={onConfirm} allowNotes {...props} />);
  return { onConfirm, onClose };
}

describe("VariationModal (página pública / garçom)", () => {
  it("não confirma com grupo obrigatório em branco e aponta o que falta", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByText("Adicionar"));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Selecione uma opção obrigatória.")).toBeTruthy();
  });

  it("confirma com a seleção e a observação", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByText("Ao ponto"));
    fireEvent.click(screen.getByText("Bacon"));
    fireEvent.change(screen.getByPlaceholderText(/sem cebola/i), { target: { value: "  sem picles  " } });
    fireEvent.click(screen.getByText("Adicionar"));

    expect(onConfirm).toHaveBeenCalledWith(
      { "Ponto da carne": "Ao ponto", Extras: ["Bacon"] },
      "sem picles"
    );
  });

  it("grupo de múltipla escolha acumula e desmarca", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByText("Mal passado"));
    fireEvent.click(screen.getByText("Bacon"));
    fireEvent.click(screen.getByText("Ovo"));
    fireEvent.click(screen.getByText("Bacon")); // desmarca
    fireEvent.click(screen.getByText("Adicionar"));

    expect(onConfirm).toHaveBeenCalledWith({ "Ponto da carne": "Mal passado", Extras: ["Ovo"] }, undefined);
  });

  it("seleção múltipla vazia não é gravada ( quebraria a chave da linha )", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByText("Bem passado"));
    fireEvent.click(screen.getByText("Bacon"));
    fireEvent.click(screen.getByText("Bacon"));
    fireEvent.click(screen.getByText("Adicionar"));

    expect(onConfirm).toHaveBeenCalledWith({ "Ponto da carne": "Bem passado" }, undefined);
  });

  it("modo edição abre com a escolha atual", () => {
    const { onConfirm } = setup({
      initialSelected: { "Ponto da carne": "Ao ponto" },
      initialNotes: "bem passado",
      confirmLabel: "Salvar alterações",
    });

    expect(screen.getByText("Ao ponto").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Bem passado"));
    fireEvent.click(screen.getByText("Salvar alterações"));
    expect(onConfirm).toHaveBeenCalledWith({ "Ponto da carne": "Bem passado" }, "bem passado");
  });

  it("Escape fecha", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("não mostra campo de observação quando allowNotes é falso (garçom)", () => {
    setup({ allowNotes: false });
    expect(screen.queryByPlaceholderText(/sem cebola/i)).toBeNull();
  });
});

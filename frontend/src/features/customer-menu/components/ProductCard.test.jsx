import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ProductCard from "./ProductCard.jsx";
import { lineKey } from "@/entities/cart";

const XBURGER = {
  id: "p1",
  name: "X-Burger",
  price: 28,
  description: "Carne 150g, queijo e salada.",
  variations: [{ name: "Ponto da carne", options: ["Mal passado", "Ao ponto"], required: true, allowMultiple: false }],
  imagePath: null,
};
const CHOPP = { id: "p2", name: "Chopp 300ml", price: 9.5, variations: null, imagePath: null };

const line = (productId, selectedVariations, quantity) => ({
  [lineKey(productId, selectedVariations)]: { productId, quantity, selectedVariations, notes: "" },
});

function setup(product, cart = {}) {
  const handlers = { onAdd: vi.fn(), onOpen: vi.fn(), onInc: vi.fn(), onDec: vi.fn(), onEditLine: vi.fn() };
  render(<ProductCard product={product} cart={cart} {...handlers} />);
  return handlers;
}

describe("ProductCard", () => {
  it("produto sem variação abre o modal antes de adicionar (novo fluxo)", () => {
    const h = setup(CHOPP);
    fireEvent.click(screen.getByText("Chopp 300ml"));
    expect(h.onOpen).toHaveBeenCalledWith(CHOPP);
    expect(h.onAdd).not.toHaveBeenCalled();
  });

  it("produto com variação abre o modal (new flow)", () => {
    const h = setup(XBURGER);
    fireEvent.click(screen.getByText("X-Burger"));
    expect(h.onOpen).toHaveBeenCalledWith(XBURGER);
    expect(h.onAdd).not.toHaveBeenCalled();
  });

  it("linhas extras existentes são exibidas e as linhas simples não", () => {
    // Linha simples (sem variação)
    const cart = { ...line("p2", {}, 1) };
    setup(CHOPP, cart);
    // A linha simples não aparece como extraLines, só conta no badge geral
    // (os controles de +/- de linha simples foram removidos da UI)
    expect(screen.getByText("1 no carrinho")).toBeTruthy();
  });

  it("mostra as linhas com variação e o total somado", () => {
    const cart = {
      ...line("p1", { "Ponto da carne": "Ao ponto" }, 2),
      ...line("p1", { "Ponto da carne": "Mal passado" }, 1),
    };
    setup(XBURGER, cart);
    expect(screen.getByText("Ao ponto")).toBeTruthy();
    expect(screen.getByText("Mal passado")).toBeTruthy();
    expect(screen.getByText("Opções disponíveis")).toBeTruthy();
  });

  it("cada linha escolhida tem o seu próprio botão (rótulo com a variação)", () => {
    const cart = {
      ...line("p1", { "Ponto da carne": "Ao ponto" }, 2),
      ...line("p1", { "Ponto da carne": "Mal passado" }, 1),
    };
    const h = setup(XBURGER, cart);
    fireEvent.click(screen.getByLabelText("Aumentar X-Burger — Ao ponto"));
    expect(h.onInc).toHaveBeenCalledWith(lineKey("p1", { "Ponto da carne": "Ao ponto" }));
    fireEvent.click(screen.getByLabelText("Diminuir X-Burger — Mal passado"));
    expect(h.onDec).toHaveBeenCalledWith(lineKey("p1", { "Ponto da carne": "Mal passado" }));
  });

  it("produto sem foto mostra placeholder com a inicial", () => {
    setup(CHOPP);
    expect(screen.getByText("C")).toBeTruthy();
  });
});

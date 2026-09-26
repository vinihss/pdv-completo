import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ProductTile from "./ProductTile.jsx";
import { lineKey } from "../cartLogic.js";

const XBURGER = {
  id: "p1",
  name: "X-Burger",
  price: 28,
  description: "Carne 150g, queijo e salada.",
  variations: [{ name: "Ponto da carne", options: ["Mal passado", "Ao ponto"], required: true, allowMultiple: false }],
  imagePath: null,
};
const CHOPP = { id: "p2", name: "Chopp 300ml", price: 9.5, variations: null, imagePath: null };

function setup(product, cart = {}) {
  const handlers = { onAdd: vi.fn(), onInc: vi.fn(), onDec: vi.fn(), onOpen: vi.fn() };
  render(<ProductTile product={product} cart={cart} {...handlers} />);
  return handlers;
}

describe("ProductTile (destaques)", () => {
  it("não há botão de +: o clique abre a ficha do produto", () => {
    const h = setup(CHOPP);
    expect(screen.queryByText("+")).toBeNull();
    fireEvent.click(screen.getByText("Chopp 300ml"));
    expect(h.onOpen).toHaveBeenCalledWith(CHOPP);
  });

  it("não há botão de + mesmo com variação obrigatória", () => {
    const h = setup(XBURGER);
    expect(screen.queryByText("+")).toBeNull();
    fireEvent.click(screen.getByText("X-Burger"));
    expect(h.onOpen).toHaveBeenCalledWith(XBURGER);
  });

  it("mostra a contagem no carrinho quando já há linha", () => {
    const cart = { [lineKey("p2", {})]: { productId: "p2", quantity: 3, selectedVariations: {}, notes: "" } };
    setup(CHOPP, cart);
    expect(screen.getByText("3 no carrinho")).toBeTruthy();
  });

  it("soma as variações do mesmo produto no counter", () => {
    const cart = {
      [lineKey("p1", { "Ponto da carne": "Mal passado" })]: { productId: "p1", quantity: 2, selectedVariations: { "Ponto da carne": "Mal passado" }, notes: "" },
      [lineKey("p1", { "Ponto da carne": "Ao ponto" })]: { productId: "p1", quantity: 1, selectedVariations: { "Ponto da carne": "Ao ponto" }, notes: "" },
    };
    setup(XBURGER, cart);
    expect(screen.getByText("3 no carrinho")).toBeTruthy();
  });

  it("o preço vem antes do título (logo abaixo da foto)", () => {
    setup(CHOPP);
    const price = screen.getByText("R$ 9,50");
    const title = screen.getByText("Chopp 300ml");
    // título vem logo abaixo do preço
    expect(title.previousElementSibling).toBe(price);
  });

  it("avisa que o produto tem opções (a vitrine é estreita)", () => {
    setup(XBURGER);
    expect(screen.getByText("opções")).toBeTruthy();
  });
});
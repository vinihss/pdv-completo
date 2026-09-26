import { describe, it, expect } from "vitest";
import {
  lineKey,
  toServerLine,
  variationGroups,
  hasVariations,
  missingRequiredGroups,
  linesOfProduct,
  productQty,
} from "./cartLogic.js";

// Produto como o menu público devolve (array de grupos) e como um backend
// desatualizado devolveria (Record<grupo, opções[]>).
const XBURGER = {
  id: "p1",
  name: "X-Burger",
  price: 28,
  variations: [{ name: "Ponto da carne", options: ["Mal passado", "Ao ponto"], required: true, allowMultiple: false }],
};
const CHOPP = { id: "p2", name: "Chopp 300ml", price: 9.5, variations: null };
const CAIPIRINHA = {
  id: "p3",
  name: "Caipirinha",
  variations: [
    { name: "Fruta", options: ["Limão", "Morango"], required: false, allowMultiple: false },
    { name: "Extras", options: ["Gelo", "Copinho"], required: false, allowMultiple: true },
  ],
};

describe("cartLogic — chave de linha", () => {
  it("mesmo produto com variações diferentes são linhas distintas", () => {
    const a = lineKey("p1", { "Ponto da carne": "Ao ponto" });
    const b = lineKey("p1", { "Ponto da carne": "Mal passado" });
    expect(a).not.toBe(b);
  });

  it("produto sem variação tem chave estável e não colide com o vazio", () => {
    expect(lineKey("p2")).toBe(lineKey("p2", {}));
    expect(lineKey("p2", {})).not.toBe(lineKey("p1", {}));
  });
});

describe("cartLogic — toServerLine", () => {
  it("omite selectedVariations vazio e notes em branco (o schema do backend rejeita)", () => {
    const line = toServerLine({ productId: "p2", quantity: 2, selectedVariations: {}, notes: "   " });
    expect(line).toEqual({ productId: "p2", quantity: 2 });
  });

  it("mantém variação e observação preenchidas", () => {
    const line = toServerLine({
      productId: "p1",
      quantity: 1,
      selectedVariations: { "Ponto da carne": "Ao ponto" },
      notes: "  sem cebola  ",
    });
    expect(line).toEqual({
      productId: "p1",
      quantity: 1,
      selectedVariations: { "Ponto da carne": "Ao ponto" },
      notes: "sem cebola",
    });
  });
});

describe("cartLogic — variaçãoGroups", () => {
  it("normaliza o formato do menu público (array de grupos)", () => {
    expect(variationGroups(XBURGER)).toEqual([
      { name: "Ponto da carne", options: ["Mal passado", "Ao ponto"], required: true, allowMultiple: false },
    ]);
  });

  it("aceita o formato legado Record<grupo, opções[]> sem quebrar", () => {
    expect(variationGroups({ id: "p4", variations: { Fruta: ["Limão"] } })).toEqual([
      { name: "Fruta", options: ["Limão"], required: false, allowMultiple: false },
    ]);
  });

  it("descarta grupo sem nome/opções e produto sem variações", () => {
    expect(variationGroups({ id: "p5", variations: [{ name: "", options: ["x"] }] })).toEqual([]);
    expect(variationGroups(CHOPP)).toEqual([]);
    expect(hasVariations(CHOPP)).toBe(false);
    expect(hasVariations(XBURGER)).toBe(true);
  });
});

describe("cartLogic — missingRequiredGroups", () => {
  it("aponta grupo obrigatório não escolhido (o caso do X-Burger sem ponto)", () => {
    expect(missingRequiredGroups(variationGroups(XBURGER), {})).toEqual(["Ponto da carne"]);
    expect(missingRequiredGroups(variationGroups(XBURGER), { "Ponto da carne": "Ao ponto" })).toEqual([]);
  });

  it("grupo opcional não é cobrado e múltipla vazia também não", () => {
    expect(missingRequiredGroups(variationGroups(CAIPIRINHA), {})).toEqual([]);
    expect(missingRequiredGroups(variationGroups(CAIPIRINHA), { Extras: [] })).toEqual([]);
  });

  it("espelha a regra do backend (domain/variations.ts)", () => {
    // mesma função, mesmas entradas → mesmo resultado dos testes do backend
    expect(missingRequiredGroups([{ name: "G", options: ["a"], required: true, allowMultiple: false }], { G: "" })).toEqual(["G"]);
  });
});

describe("cartLogic — linhas por produto", () => {
  const cart = {
    [lineKey("p1", { "Ponto da carne": "Ao ponto" })]: {
      productId: "p1",
      quantity: 2,
      selectedVariations: { "Ponto da carne": "Ao ponto" },
      notes: "",
    },
    [lineKey("p1", { "Ponto da carne": "Mal passado" })]: {
      productId: "p1",
      quantity: 1,
      selectedVariations: { "Ponto da carne": "Mal passado" },
      notes: "",
    },
    [lineKey("p2", {})]: { productId: "p2", quantity: 3, selectedVariations: {}, notes: "" },
  };

  it("soma a quantidade de todas as variações do produto", () => {
    expect(productQty(cart, "p1")).toBe(3);
    expect(productQty(cart, "p2")).toBe(3);
    expect(productQty(cart, "inexistente")).toBe(0);
  });

  it("linesOfProduct devolve as duas linhas do mesmo produto", () => {
    expect(linesOfProduct(cart, "p1").map((l) => l.quantity)).toEqual([2, 1]);
  });
});


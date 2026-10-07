// Carrinho de lançamento: linhas por produto+variação, totais e o payload que
// o backend espera. Lógica pura — sem storage, sem render.
import {
  addLine,
  cartCount,
  cartLines,
  cartTotal,
  changeNotes,
  hasVariations,
  lineKey,
  missingRequiredGroups,
  productQty,
  removeLine,
  toServerItems,
  variationGroups,
} from "./cartLogic.js";

function product(id, variations) {
  return { id, name: `Produto ${id}`, price: 10, ...(variations ? { variations } : {}) };
}

describe("lineKey", () => {
  it("mesmo produto com variação diferente são linhas diferentes", () => {
    expect(lineKey("p1", { Ponto: "Mal passado" })).not.toBe(lineKey("p1", { Ponto: "Bem passado" }));
  });
});

describe("addLine / removeLine", () => {
  it("adiciona 1 à linha existente do mesmo produto+variação", () => {
    let cart = {};
    cart = addLine(cart, product("p1"));
    cart = addLine(cart, product("p1"));
    expect(cartCount(cart)).toBe(2);
    expect(cartLines(cart)).toHaveLength(1);
  });

  it("produto com variação diferente vira outra linha", () => {
    let cart = {};
    cart = addLine(cart, product("p1"), { Ponto: "Ao ponto" });
    cart = addLine(cart, product("p1"), { Ponto: "Bem passado" });
    expect(cartLines(cart)).toHaveLength(2);
    expect(cartCount(cart)).toBe(2);
  });

  it("removeLine apaga a linha inteira", () => {
    let cart = addLine({}, product("p1"));
    const key = lineKey("p1", {});
    expect(removeLine(cart, key)).toEqual({});
    expect(removeLine({}, "key-que-nao-existe")).toEqual({});
  });

  it("changeNotes adiciona/atualiza observação sem criar linha nova", () => {
    let cart = addLine({}, product("p1"));
    const key = lineKey("p1", {});
    cart = changeNotes(cart, key, "sem cebola");
    expect(cartLines(cart)[0].notes).toBe("sem cebola");
    expect(Object.keys(cart)).toHaveLength(1);
  });
});

describe("totais", () => {
  it("productQty soma linhas com variações do mesmo produto", () => {
    let cart = {};
    cart = addLine(cart, product("p1"), { Ponto: "Ao ponto" });
    cart = addLine(cart, product("p1"), { Ponto: "Bem passado" });
    cart = addLine(cart, product("p2"));
    expect(productQty(cart, "p1")).toBe(2);
    expect(productQty(cart, "p2")).toBe(1);
  });

  it("cartTotal soma preço × quantidade", () => {
    let cart = {};
    const p = product("p1");
    p.price = 12.5;
    cart = addLine(cart, p);
    cart = addLine(cart, p);
    expect(cartTotal(cart)).toBe(25);
  });
});

describe("toServerItems", () => {
  it("monta o payload sem campos vazios", () => {
    let cart = {};
    cart = addLine(cart, product("p1"));
    cart = addLine(cart, product("p2"), { Ponto: "Mal passado" });
    cart = changeNotes(cart, lineKey("p1", {}), "  sem cebola  ");
    expect(toServerItems(cart)).toEqual([
      { productId: "p1", quantity: 1, notes: "sem cebola" },
      { productId: "p2", quantity: 1, selectedVariations: { Ponto: "Mal passado" } },
    ]);
  });
});

describe("variações", () => {
  it("variationGroups normaliza array e formato antigo (Record)", () => {
    const arrayProd = product("a", [{ name: "Ponto", options: ["Ao ponto", "Bem passado"], required: true, allowMultiple: false }]);
    expect(variationGroups(arrayProd)).toEqual([
      { name: "Ponto", options: ["Ao ponto", "Bem passado"], required: true, allowMultiple: false },
    ]);
    const recordProd = { id: "b", name: "B", price: 1, variations: { Extra: ["Bacon", "Queijo"] } };
    expect(variationGroups(recordProd)).toEqual([
      { name: "Extra", options: ["Bacon", "Queijo"], required: false, allowMultiple: false },
    ]);
    expect(variationGroups(product("c"))).toEqual([]);
  });

  it("hasVariations é true só quando há grupo válido", () => {
    expect(hasVariations(product("c"))).toBe(false);
    expect(hasVariations(product("a", [{ name: "Ponto", options: ["Ao ponto"], required: false }]))).toBe(true);
  });

  it("missingRequiredGroups aponta só os obrigatórios sem seleção", () => {
    const groups = [
      { name: "Ponto", required: true },
      { name: "Extra", required: false },
    ];
    expect(missingRequiredGroups(groups, { Ponto: [] })).toEqual(["Ponto"]);
    expect(missingRequiredGroups(groups, { Ponto: "Ao ponto" })).toEqual([]);
  });
});
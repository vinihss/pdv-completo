// Persistência do carrinho por comanda sobre o adapter de storage (MMKV mock).
import { storage } from "@/shared/lib/storage";
import { clearCart, loadCart, saveCart } from "./cartStorage.js";

describe("cartStorage", () => {
  beforeEach(() => {
    storage.clear();
  });

  function cartLine({ key = "p1{}", id = "p1", name = "Produto", price = 10, qty = 1, notes = "", variations = {} } = {}) {
    return { key, product: { id, name, price }, quantity: qty, selectedVariations: variations, notes };
  }

  it("salva e recarrega o carrinho com o snapshot do produto", () => {
    const cart = { [cartLine().key]: cartLine() };
    saveCart("order-1", cart);
    const loaded = loadCart("order-1");
    expect(loaded[cartLine().key]).toEqual({
      key: "p1{}",
      product: { id: "p1", name: "Produto", price: 10 },
      quantity: 1,
      selectedVariations: {},
      notes: "",
    });
  });

  it("carrinhos diferentes ficam isolados por comanda", () => {
    saveCart("order-1", { ["p1{}"]: cartLine() });
    const outro = cartLine({ key: "p2{}", id: "p2", name: "Outro", price: 5 });
    saveCart("order-2", { [outro.key]: outro });
    expect(loadCart("order-1")["p1{}"].product.name).toBe("Produto");
    expect(loadCart("order-2")["p2{}"].product.name).toBe("Outro");
  });

  it("salvar carrinho vazio limpa a chave", () => {
    saveCart("order-1", { ["p1{}"]: cartLine() });
    saveCart("order-1", {});
    expect(loadCart("order-1")).toBeNull();
  });

  it("clearCart remove a chave", () => {
    saveCart("order-1", { ["p1{}"]: cartLine() });
    clearCart("order-1");
    expect(loadCart("order-1")).toBeNull();
  });

  it("payload expirado é descartado (e limpo)", () => {
    const fakeClock = jest.spyOn(Date, "now").mockReturnValue(0);
    saveCart("order-1", { ["p1{}"]: cartLine() });
    fakeClock.mockReturnValue(6 * 60 * 60 * 1000 + 1); // TTL 6h ultrapassado
    expect(loadCart("order-1")).toBeNull();
    fakeClock.mockRestore();
  });

  it("carrinho de produto removido do cardápio é reconstruído sem essa linha", () => {
    saveCart("order-1", {
      ["a{}"]: { key: "a{}", product: { id: "a", name: "A", price: 1 }, quantity: 1, selectedVariations: {}, notes: "" },
      ["b{}"]: { key: "b{}", product: { id: null, name: "", price: 0 }, quantity: 1, selectedVariations: {}, notes: "" },
    });
    const loaded = loadCart("order-1");
    expect(Object.keys(loaded)).toEqual(["a{}"]);
  });

  it("storage corrompido devolve null sem explodir", () => {
    storage.setItem("pdv:order-cart:order-1", "{não é json");
    expect(loadCart("order-1")).toBeNull();
  });
});
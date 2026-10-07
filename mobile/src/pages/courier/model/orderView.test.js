// Canônica: port de frontend/src/pages/courier/model/orderView.test.js (import
// do vitest removido — jest-expo provê describe/it/expect como globais). As
// coberturas exclusivas da cópia que existia em model/__tests__/orderView.test.js
// (endereço, coordenadas e o teto de 4 linhas do card) foram unidas aqui.
import { addressText, deliveryDestination, estimatedText, orderLines, orderNote, shortOrderId } from "./orderView.js";

/**
 * O contrato de dados de `GET /courier/deliveries` é produzido por outro
 * agente e pode não estar neste branch — então o alvo aqui não é "renderizar o
 * campo novo", é "não quebrar sem ele". Cada teste tira um campo do payload e
 * exige que a leitura continue devolvendo algo que a tela sabe desenhar (ou
 * `null`, que a tela sabe esconder).
 */
describe("shortOrderId", () => {
  it("corta o uuid nos 8 primeiros caracteres", () => {
    expect(shortOrderId("abcdefgh-1234-5678")).toBe("Pedido #abcdefgh");
  });

  it("devolve null sem orderId ou com string vazia", () => {
    expect(shortOrderId(undefined)).toBeNull();
    expect(shortOrderId(null)).toBeNull();
    expect(shortOrderId("   ")).toBeNull();
  });

  it("aceita id curto sem cortar nada além do que existe", () => {
    expect(shortOrderId("abc")).toBe("Pedido #abc");
  });
});

describe("estimatedText", () => {
  it("formata minutos e horas", () => {
    expect(estimatedText(30)).toBe("≈ 30 min");
    expect(estimatedText(90)).toBe("≈ 1 h 30");
    expect(estimatedText(60)).toBe("≈ 1 h");
  });

  it("devolve null quando não vier ou for lixo (≈0 min é pior que nada)", () => {
    expect(estimatedText(undefined)).toBeNull();
    expect(estimatedText(null)).toBeNull();
    expect(estimatedText(0)).toBeNull();
    expect(estimatedText(-5)).toBeNull();
    expect(estimatedText("abc")).toBeNull();
  });
});

describe("orderLines", () => {
  it("lê itens como objetos, com quantidade e observação", () => {
    expect(orderLines({ items: [{ name: "X-Burger", quantity: 2, notes: "sem cebola" }] })).toEqual([
      "2× X-Burger — sem cebola",
    ]);
  });

  it("lê itens como string e com nome em campo alternativo", () => {
    expect(orderLines({ items: ["Coca 350ml"] })).toEqual(["Coca 350ml"]);
    expect(orderLines({ items: [{ productName: "Batata", qty: 1 }] })).toEqual(["Batata"]);
  });

  it("aceita orderItems e order.items (formato ainda não é contrato)", () => {
    expect(orderLines({ orderItems: [{ name: "Suco" }] })).toEqual(["Suco"]);
    expect(orderLines({ order: { items: [{ name: "Pudim" }] } })).toEqual(["Pudim"]);
  });

  it("ignora linha sem nome e nunca devolve undefined na lista", () => {
    expect(orderLines({ items: [{ quantity: 1 }, { name: "Café" }, null, 7] })).toEqual(["Café"]);
  });

  it("devolve lista vazia quando não houver payload de itens", () => {
    expect(orderLines({})).toEqual([]);
    expect(orderLines({ items: "não é lista" })).toEqual([]);
    expect(orderLines(null)).toEqual([]);
  });

  it("joga a observação do pedido como OBS no fim", () => {
    expect(orderLines({ items: [{ name: "Café" }], orderNotes: "bem quente" })).toEqual([
      "Café",
      "OBS: bem quente",
    ]);
  });

  // Liberdade em relação ao web: no celular mais de 4 linhas de item é rolagem
  // dentro de um card que se lê com uma mão. A OBS não conta no teto — ela é
  // uma linha só e é justamente a que evita o retorno.
  it("mostra no máximo 4 linhas de item", () => {
    const lines = orderLines({
      items: [
        { quantity: 2, productName: "Pizza" },
        { name: "Coca" },
        { quantity: 1, productName: "Sorvete" },
        { quantity: 3, productName: "Batata" },
        { quantity: 1, productName: "Extra" },
      ],
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("2× Pizza");
    expect(lines.some((l) => l.includes("Extra"))).toBe(false);
  });
});

describe("orderNote", () => {
  it("lê a observação de onde ela vier", () => {
    expect(orderNote({ orderNotes: "a" })).toBe("a");
    expect(orderNote({ orderNote: "b" })).toBe("b");
    expect(orderNote({ order: { notes: "c" } })).toBe("c");
  });

  it("NÃO lê notes de uma entrega failed: ali o campo é o motivo da falha", () => {
    // Se passasse, o card diria ao entregador que o cliente pediu "sem cebola"
    // quando ele acabou de escrever "cliente ausente".
    expect(orderNote({ status: "failed", notes: "Cliente ausente" })).toBeNull();
    // Fora de `failed` nada grava o campo, então ele é observação.
    expect(orderNote({ status: "awaiting_courier", notes: "sem cebola" })).toBe("sem cebola");
  });

  it("devolve null quando não vier nada", () => {
    expect(orderNote({})).toBeNull();
    expect(orderNote(undefined)).toBeNull();
    expect(orderNote({ orderNotes: "  " })).toBeNull();
  });
});

describe("addressText", () => {
  it("usa a string do contrato (`address` é string em GET /courier/deliveries)", () => {
    expect(addressText({ address: "Rua das Flores, 123 - Centro" })).toBe("Rua das Flores, 123 - Centro");
  });

  it("monta a partir do objeto, quando vier assim", () => {
    const d = { address: { street: "Rua X", number: "123", neighborhood: "Centro", city: "SP", state: "SP" } };
    expect(addressText(d)).toContain("Rua X");
    expect(addressText(d)).toContain("123");
  });

  it("fallback para addressText", () => {
    expect(addressText({ addressText: "Av Y, 456" })).toBe("Av Y, 456");
  });

  it("sem endereço devolve string vazia (o card some com a seção)", () => {
    expect(addressText({})).toBe("");
    expect(addressText(null)).toBe("");
    expect(addressText({ address: "   " })).toBe("");
  });
});

describe("deliveryDestination", () => {
  it("extrai coordenadas do objeto address", () => {
    expect(deliveryDestination({ address: { latitude: -23.5, longitude: -46.6 } })).toEqual({
      latitude: -23.5,
      longitude: -46.6,
    });
  });

  it("usa addressLatitude/addressLongitude de topo (é o que o contrato manda)", () => {
    expect(deliveryDestination({ address: "Rua X, 1", addressLatitude: -23.5, addressLongitude: -46.6 })).toEqual({
      latitude: -23.5,
      longitude: -46.6,
    });
  });

  it("retorna null quando falta", () => {
    expect(deliveryDestination({ address: {} })).toBeNull();
    expect(deliveryDestination({ address: "Rua X, 1" })).toBeNull();
    expect(deliveryDestination({})).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { toDaemonOrder, toPrintRequest } from "./daemonOrder.js";

/**
 * O cupom impresso é a única versão da comanda que o garçom entrega ao
 * cliente — não há como corrigir depois. Estes testes fixam as decisões que
 * divergem do backend de propósito (total sem item cancelado) e as que
 * quebram em silêncio: centavos, vírgula flutuante e `job_id` instável.
 */

const item = (over = {}) => ({
  name: "Hambúrguer",
  quantity: 1,
  unitPrice: 25.9,
  selectedVariations: {},
  notes: null,
  status: "ordered",
  ...over,
});

const order = (over = {}) => ({
  id: "ord-1234567890",
  channel: "balcao",
  openedAt: "2026-09-29T12:00:00.000Z",
  tabLabel: null,
  customerName: null,
  tableNumber: null,
  deliveryFee: null,
  items: [item()],
  payments: [],
  ...over,
});

describe("toDaemonOrder — total", () => {
  it("converte para centavos sem erro de ponto flutuante", () => {
    // 0.1 + 0.2 === 0.30000000000000004: em centavos, isso daria 30.000000000000004
    // e o daemon receberia um total que não bate com a soma dos itens.
    const result = toDaemonOrder(
      order({ items: [item({ unitPrice: 0.1 }), item({ unitPrice: 0.2, name: "Refri" })] }),
    );
    expect(result.total_cents).toBe(30);
    expect(result.items.map((i) => i.unit_price_cents)).toEqual([10, 20]);
  });

  it("ignora item cancelado, igual ao total da tela", () => {
    // O mapper do backend soma todos os itens; aqui o papel precisa bater com
    // o que o garçom vê. Se o item foi cancelado na tela, não vai ao cupom.
    const result = toDaemonOrder(
      order({
        items: [
          item(),
          item({ name: "Cerveja", unitPrice: 12, status: "cancelled" }),
        ],
      }),
    );
    expect(result.total_cents).toBe(2590);
    // O item cancelado continua na lista, mas sem custo no total: o operador
    // precisa ver que ele foi rethinking, não simplesmente sumir.
    expect(result.items).toHaveLength(2);
  });

  it("soma taxa de entrega", () => {
    const result = toDaemonOrder(order({ channel: "whatsapp", deliveryFee: 7.5 }));
    expect(result.total_cents).toBe(3340); // 25.90 + 7.50
  });

  it("soma quantidade", () => {
    const result = toDaemonOrder(order({ items: [item({ quantity: 3 })] }));
    expect(result.total_cents).toBe(7770);
  });
});

describe("toDaemonOrder — identificação do pedido", () => {
  it("prefere a etiqueta da comanda", () => {
    expect(toDaemonOrder(order({ tabLabel: "A-12" })).number).toBe("A-12");
  });

  it("usa o número da mesa quando não há etiqueta", () => {
    expect(toDaemonOrder(order({ tableNumber: 7 })).number).toBe("Mesa 7");
  });

  it("cai para o id quando não há mesa nem cliente", () => {
    expect(toDaemonOrder(order()).number).toBe("ord-1234");
  });
});

describe("toDaemonOrder — canal", () => {
  it("traduz os canais do PDV para os rótulos do cupom", () => {
    expect(toDaemonOrder(order({ channel: "balcao" })).type).toBe("MESA");
    expect(toDaemonOrder(order({ channel: "whatsapp" })).type).toBe("DELIVERY");
    expect(toDaemonOrder(order({ channel: "web" })).type).toBe("DELIVERY");
    expect(toDaemonOrder(order({ channel: "ifood" })).type).toBe("IFOOD");
  });

  it("desconhecido vira maiúscula em vez de sumir", () => {
    expect(toDaemonOrder(order({ channel: "kiosk" })).type).toBe("KIOSK");
  });
});

describe("toDaemonOrder — adicionais", () => {
  it("achata variações em lista de adicionais", () => {
    const result = toDaemonOrder(
      order({
        items: [
          item({ selectedVariations: { "Ponto da carne": "Mal passado", Queijos: ["Cheddar", "Bacon"] } }),
        ],
      }),
    );
    expect(result.items[0].addons).toEqual(["Mal passado", "Cheddar", "Bacon"]);
  });

  it("não quebra com variações vazias ou ausentes", () => {
    expect(toDaemonOrder(order({ items: [item({ selectedVariations: null })] })).items[0].addons).toEqual([]);
    expect(toDaemonOrder(order({ items: [item({ selectedVariations: { Molho: "" } })] })).items[0].addons).toEqual([]);
  });
});

describe("toDaemonOrder — cliente, entrega e pagamento", () => {
  it("inclui cliente quando há nome", () => {
    const result = toDaemonOrder(order({ customerName: "Maria", customerPhone: "11988887777" }));
    expect(result.customer).toEqual({ name: "Maria", phone: "11988887777" });
  });

  it("omite bloco de cliente quando não há", () => {
    expect(toDaemonOrder(order()).customer).toBeUndefined();
  });

  it("coloca o endereço completo no campo address", () => {
    // O PDV não tem CEP/número/bairro estruturados; o mapper do backend
    // manda a linha inteira em `address` e segue assim.
    const result = toDaemonOrder(
      order({ delivery: { address: "Rua das Flores, 120 - Apto 4", notes: "portão azul" } }),
    );
    expect(result.delivery).toEqual({
      address: "Rua das Flores, 120 - Apto 4",
      number: "",
      complement: "",
      neighborhood: "",
      reference: "portão azul",
    });
  });

  it("omite entrega sem endereço", () => {
    expect(toDaemonOrder(order({ delivery: { notes: "só observação" } })).delivery).toBeUndefined();
    expect(toDaemonOrder(order()).delivery).toBeUndefined();
  });

  it("leva troco em centavos só no pagamento em dinheiro", () => {
    const result = toDaemonOrder(
      order({ payments: [{ method: "card", amount: 25.9, change: null }, { method: "cash", amount: 50, change: 24.1 }] }),
    );
    expect(result.payment).toEqual({ method: "cash", change_cents: 2410 });
  });

  it("omite pagamento quando não há dinheiro", () => {
    expect(toDaemonOrder(order({ payments: [{ method: "pix", amount: 25.9, change: null }] })).payment).toBeUndefined();
  });
});

describe("toPrintRequest — idempotência", () => {
  it("mantém job_id estável por pedido e destino", () => {
    // O daemon tem UNIQUE(order_id, destination) com ON CONFLICT DO UPDATE.
    // Um job_id com timestamp criaria um segundo job a cada clique, e a
    // cozinha receberia a comanda duplicada.
    const a = toPrintRequest(order(), "kitchen");
    const b = toPrintRequest(order(), "kitchen");
    expect(a.job_id).toBe("ord-1234567890-kitchen");
    expect(a.job_id).toBe(b.job_id);
  });

  it("separa cozinha e entrega", () => {
    expect(toPrintRequest(order(), "kitchen").job_id).toBe("ord-1234567890-kitchen");
    expect(toPrintRequest(order(), "courier").job_id).toBe("ord-1234567890-courier");
  });

  it("carrega order_id e o pedido no envelope", () => {
    const req = toPrintRequest(order(), "kitchen");
    expect(req.order_id).toBe("ord-1234567890");
    expect(req.destination).toBe("kitchen");
    expect(req.order.total_cents).toBe(2590);
  });
});

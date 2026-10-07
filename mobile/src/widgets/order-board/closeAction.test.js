// Regra do rodapé "Fechar conta" (closeAction.js) — pura, testada sem render.
// A tela só executa: quem decide entre bloquear/pagamento/fechar (e o que a
// falha do backend significa) é aqui.
import { closeFailure, closePlan } from "./closeAction.js";

describe("closePlan", () => {
  it("item pendente bloqueia o botão", () => {
    expect(closePlan({ pendingCount: 2, hasPayments: true })).toBe("blocked");
    expect(closePlan({ pendingCount: 1, hasPayments: false })).toBe("blocked");
  });

  it("sem pendência e sem pagamento leva para o pagamento", () => {
    expect(closePlan({ pendingCount: 0, hasPayments: false })).toBe("payment");
  });

  it("tudo certo fecha a conta", () => {
    expect(closePlan({ pendingCount: 0, hasPayments: true })).toBe("close");
  });
});

describe("closeFailure", () => {
  it("pending_items vira aviso com os NOMES dos itens (AC §5)", () => {
    const failure = closeFailure({
      code: "pending_items",
      details: { pendingItems: [{ name: "Cerveja" }, { name: "Porção" }] },
    });

    expect(failure.kind).toBe("pending");
    expect(failure.message).toBe("Ainda há itens pendentes: Cerveja, Porção");
  });

  it("pending_items sem details não quebra a mensagem", () => {
    const failure = closeFailure({ code: "pending_items" });

    expect(failure.kind).toBe("pending");
    expect(failure.message).toBe("Ainda há itens pendentes.");
  });

  it("erros de pagamento levam para a tela de pagamento", () => {
    for (const code of ["payment_not_registered", "payment_not_confirmed", "invalid_payment_total"]) {
      expect(closeFailure({ code }).kind).toBe("payment");
    }
  });

  it("qualquer outro erro vira toast com a mensagem do backend", () => {
    const failure = closeFailure({ code: "order_not_open", message: "Comanda já fechada." });

    expect(failure.kind).toBe("toast");
    expect(failure.message).toBe("Comanda já fechada.");
  });

  it("erro sem código/mensagem não derruba a tela", () => {
    expect(closeFailure(null)).toEqual({ kind: "toast", message: "Não foi possível fechar a comanda." });
    expect(closeFailure(new Error("sem rede")).message).toBe("sem rede");
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, normalizeText } from "./classifier.mjs";

test("classifica formas variadas de iniciar pedido", () => {
  for (const phrase of ["Quero pedir de novo", "manda o cardápio", "vou fazer outro pedido", "quero comprar comida"]) {
    assert.equal(classifyIntent(phrase).intent, "new_order", phrase);
  }
});

test("classifica acompanhamento sem exigir a palavra status", () => {
  for (const phrase of ["onde está meu pedido?", "meu pedido já saiu?", "quanto falta para chegar", "quero saber da entrega"]) {
    assert.equal(classifyIntent(phrase).intent, "track_order", phrase);
  }
});

test("reconhece opções numéricas e mantém compatibilidade com o menu", () => {
  assert.equal(classifyIntent("1").intent, "new_order");
  assert.equal(classifyIntent("2").intent, "track_order");
});

test("mensagens sem contexto de pedido são classificadas como fora de escopo", () => {
  for (const phrase of ["oi, tudo bem?", "obrigado", "qual o endereço da loja?"]) {
    const result = classifyIntent(phrase);
    assert.equal(result.intent, "unrelated", phrase);
    assert.equal(result.inScope, false, phrase);
  }
});

test("solicita esclarecimento para mensagem curta ou ambígua relacionada a pedido", () => {
  assert.equal(classifyIntent("pedido").intent, "unclear");
  assert.equal(classifyIntent("vocês entregam?").intent, "unclear");
  assert.equal(classifyIntent("vocês entregam?").inScope, true);
});

test("normaliza acentos e pontuação para a representação local", () => {
  assert.equal(normalizeText("AÇÃO, PEDIDO!") , "acao pedido");
});

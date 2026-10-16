import test from "node:test";
import assert from "node:assert/strict";
import { classifyChoice, extractDirectContactId, isOrderIntent } from "./filters.mjs";

test("identifica telefone individual a partir do identificador c.us", () => {
  assert.deepEqual(extractDirectContactId("false_5511999999999@c.us_ABCD"), {
    group: false,
    phone: "5511999999999",
    contactId: "5511999999999@c.us",
  });
});

test("exclui grupos e falha fechado para identificadores não reconhecidos", () => {
  assert.deepEqual(extractDirectContactId("false_120363012345678901@g.us_ABCD"), { group: true });
  assert.equal(extractDirectContactId("false_12345@lid_ABCD"), null);
  assert.equal(extractDirectContactId(undefined), null);
});

test("aceita sinais de pedido e ignora conversa sem contexto de pedido", () => {
  assert.equal(isOrderIntent("Quero acompanhar meu pedido"), true);
  assert.equal(isOrderIntent("Tem cardápio?"), true);
  assert.equal(isOrderIntent("Oi, tudo bem?"), false);
  assert.equal(isOrderIntent("Me manda o status do evento"), false);
  assert.equal(isOrderIntent("Obrigado!"), false);
});

test("classifica apenas escolhas esperadas no menu inicial", () => {
  assert.equal(classifyChoice("1"), "new_order");
  assert.equal(classifyChoice("acompanhar pedido"), "track_order");
  assert.equal(classifyChoice("oi"), null);
});

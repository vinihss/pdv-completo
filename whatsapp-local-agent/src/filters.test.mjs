import test from "node:test";
import assert from "node:assert/strict";
import { extractChatIdentityFromMetadata, extractDirectContactId } from "./filters.mjs";

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

test("a lista só autoriza abrir um contato com JID c.us explícito", () => {
  assert.deepEqual(extractChatIdentityFromMetadata(["row", "false_5511999999999@c.us_ABC"]), {
    group: false,
    phone: "5511999999999",
    contactId: "5511999999999@c.us",
  });
  assert.deepEqual(extractChatIdentityFromMetadata(["120363012345678901@g.us"]), { group: true });
  assert.equal(extractChatIdentityFromMetadata(["Ceci", "1 mensagem não lida"]), null);
});

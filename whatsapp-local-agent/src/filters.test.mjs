import test from "node:test";
import assert from "node:assert/strict";
import { extractChatIdentityFromMetadata, extractDirectContactId, isWithinLast24Hours, parseChatActivityTimestamp } from "./filters.mjs";

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

test("só considera chat se o horário de atividade puder ser confirmado dentro das últimas 24 horas", () => {
  const now = new Date(2026, 9, 18, 12, 0, 0).getTime();
  const recent = parseChatActivityTimestamp("11:59", now);
  const old = parseChatActivityTimestamp("16/10/2026, 11:59", now);
  assert.equal(isWithinLast24Hours(recent, now), true);
  assert.equal(isWithinLast24Hours(old, now), false);
  assert.equal(isWithinLast24Hours(parseChatActivityTimestamp("Ontem", now), now), false);
  assert.equal(isWithinLast24Hours(parseChatActivityTimestamp([], now), now), false);
  assert.equal(isWithinLast24Hours(now + 60_000, now), false);
});

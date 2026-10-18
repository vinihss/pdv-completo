import test from "node:test";
import assert from "node:assert/strict";
import { extractChatIdentityFromMetadata, extractDirectContactId, isConfiguredTestContact, isNewVerifiedTestMessage, isWithinLast24Hours, parseChatActivityTimestamp } from "./filters.mjs";
import { classifyIntent } from "./classifier.mjs";

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

test("interpreta formatos de horário usados pela interface em português e inglês", () => {
  const now = new Date(2026, 9, 18, 1, 18, 0).getTime();
  const yesterdayLate = parseChatActivityTimestamp("Ontem às 23:45", now, "pt-BR");
  const yesterdayEarly = parseChatActivityTimestamp("Ontem, 00:30", now, "pt-BR");
  const usDate = parseChatActivityTimestamp("10/17/2026, 11:45 PM", now, "en-US");
  const todayAm = parseChatActivityTimestamp("1:10 AM", now, "en-US");
  const iso = parseChatActivityTimestamp(new Date(now - 15 * 60_000).toISOString(), now, "en-US");

  assert.equal(isWithinLast24Hours(yesterdayLate, now), true);
  assert.equal(isWithinLast24Hours(yesterdayEarly, now), false);
  assert.equal(isWithinLast24Hours(usDate, now), true);
  assert.equal(isWithinLast24Hours(todayAm, now), true);
  assert.equal(isWithinLast24Hours(iso, now), true);
  assert.equal(parseChatActivityTimestamp("Ontem", now, "pt-BR"), null);
});

test("simula mensagem nova no chat de teste mesmo já lida e com atividade antiga", () => {
  const configuredPhone = "51992237727";
  const rowIdentity = extractChatIdentityFromMetadata(["false_51992237727@c.us_ROW"]);
  const messageIdentity = extractDirectContactId("false_51992237727@c.us_MSG123");
  const unread = false;
  const activityTimestamp = Date.now() - 48 * 60 * 60 * 1000;

  assert.equal(unread, false);
  assert.equal(isWithinLast24Hours(activityTimestamp), false);
  assert.equal(isConfiguredTestContact(rowIdentity, configuredPhone), true);
  assert.equal(isNewVerifiedTestMessage({ identity: messageIdentity, configuredPhone, messageKey: "false_51992237727@c.us_MSG123", lastProcessedMessageKey: "" }), true);
  assert.equal(classifyIntent("quero fazer um pedido").intent, "new_order");
  assert.equal(isNewVerifiedTestMessage({ identity: messageIdentity, configuredPhone, messageKey: "false_51992237727@c.us_MSG123", lastProcessedMessageKey: "false_51992237727@c.us_MSG123" }), false);
  assert.equal(isConfiguredTestContact({ group: true, phone: configuredPhone, contactId: `${configuredPhone}@c.us` }, configuredPhone), false);
});

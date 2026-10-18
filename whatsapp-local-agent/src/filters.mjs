export function extractDirectContactId(messageId) {
  if (!messageId) return null;
  if (/@g\.us(?:_|$)/i.test(messageId)) return { group: true };
  const match = messageId.match(/(?:^|_)(\d{7,20})@(c\.us)(?:_|$)/i);
  if (!match) return null;
  return { group: false, phone: match[1], contactId: `${match[1]}@c.us` };
}

// A lista lateral às vezes expõe o JID em atributos data-id/data-jid/href.
// Só se autoriza abrir um chat quando um @c.us explícito está presente; nome
// visível, telefone formatado e heurísticas por avatar não bastam.
export function extractChatIdentityFromMetadata(values) {
  const raw = (Array.isArray(values) ? values : [values]).filter(Boolean).join("\n");
  if (/@\s*g\.us\b/i.test(raw)) return { group: true };
  const match = raw.match(/(?:^|[^\d])(\d{7,20})@c\.us(?:[^a-z0-9]|$)/i);
  if (!match) return null;
  return { group: false, phone: match[1], contactId: `${match[1]}@c.us` };
}

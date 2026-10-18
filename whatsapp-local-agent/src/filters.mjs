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

export function parseChatActivityTimestamp(values, now = Date.now()) {
  const candidates = (Array.isArray(values) ? values : [values]).filter(Boolean).map((value) => String(value).trim());
  for (const value of candidates) {
    const iso = value.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/);
    if (iso) {
      const timestamp = Date.parse(iso[0]);
      if (Number.isFinite(timestamp)) return timestamp;
    }
    const local = value.match(/(?:^|\b)(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})(?:[, ]+)(\d{1,2}):(\d{2})(?:\b|$)/);
    if (local) {
      let [, day, month, year, hour, minute] = local;
      year = Number(year);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
      if (date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day)) return date.getTime();
    }
    if (/^(?:hoje\s+)?\d{1,2}:\d{2}$/i.test(value)) {
      const [, hour, minute] = value.match(/(\d{1,2}):(\d{2})/);
      const date = new Date(now);
      date.setHours(Number(hour), Number(minute), 0, 0);
      return date.getTime();
    }
  }
  return null;
}

export function isWithinLast24Hours(timestamp, now = Date.now()) {
  return Number.isFinite(timestamp) && timestamp <= now && timestamp >= now - 24 * 60 * 60 * 1000;
}

export function isConfiguredTestContact(identity, configuredPhone) {
  const phone = String(configuredPhone || "").replace(/\D/g, "");
  return Boolean(phone && identity && !identity.group && identity.phone === phone && identity.contactId === `${phone}@c.us`);
}

export function isNewVerifiedTestMessage({ identity, configuredPhone, messageKey, lastProcessedMessageKey }) {
  return Boolean(
    messageKey
    && messageKey !== lastProcessedMessageKey
    && isConfiguredTestContact(identity, configuredPhone)
  );
}

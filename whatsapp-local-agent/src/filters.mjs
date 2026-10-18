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

function parseClock(value) {
  const match = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = match[4]?.toLowerCase().replace(/\./g, "");
  if (minute > 59 || second > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute, second };
}

function localTimestamp(year, month, day, clock) {
  const result = new Date(year, month - 1, day, clock.hour, clock.minute, clock.second, 0);
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) return null;
  return result.getTime();
}

export function parseChatActivityTimestamp(values, now = Date.now(), locale = "pt-BR") {
  const candidates = (Array.isArray(values) ? values : [values]).filter(Boolean).map((value) => String(value).trim());
  const reference = new Date(now);
  const dayNames = new Map([
    ["sunday", 0], ["sun", 0], ["domingo", 0], ["dom", 0],
    ["monday", 1], ["mon", 1], ["segunda-feira", 1], ["segunda", 1], ["seg", 1],
    ["tuesday", 2], ["tue", 2], ["tues", 2], ["terça-feira", 2], ["terca-feira", 2], ["terça", 2], ["terca", 2], ["ter", 2],
    ["wednesday", 3], ["wed", 3], ["quarta-feira", 3], ["quarta", 3], ["qua", 3],
    ["thursday", 4], ["thu", 4], ["thur", 4], ["thurs", 4], ["quinta-feira", 4], ["quinta", 4], ["qui", 4],
    ["friday", 5], ["fri", 5], ["sexta-feira", 5], ["sexta", 5], ["sex", 5],
    ["saturday", 6], ["sat", 6], ["sábado", 6], ["sabado", 6], ["sab", 6],
  ]);

  for (const value of candidates) {
    const epoch = value.match(/^\s*(\d{10}|\d{13})\s*$/);
    if (epoch) {
      const numeric = Number(epoch[1]);
      return epoch[1].length === 10 ? numeric * 1000 : numeric;
    }

    const iso = value.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/i);
    if (iso) {
      const timestamp = Date.parse(iso[0]);
      if (Number.isFinite(timestamp)) return timestamp;
    }

    const ymd = value.match(/^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)(.*)$/i);
    if (ymd) {
      const zoneSuffix = ymd[5].trim();
      const clock = parseClock(ymd[4]);
      if (clock) {
        if (zoneSuffix && Number.isFinite(Date.parse(value))) return Date.parse(value);
        const timestamp = localTimestamp(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), clock);
        if (timestamp !== null) return timestamp;
      }
    }

    const dateTime = value.match(/(?:^|\D)(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})(?:[, T]+)(\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i);
    if (dateTime) {
      const first = Number(dateTime[1]);
      const second = Number(dateTime[2]);
      const yearRaw = Number(dateTime[3]);
      const year = yearRaw < 100 ? yearRaw + (yearRaw >= 70 ? 1900 : 2000) : yearRaw;
      const monthFirst = second > 12 || (first <= 12 && second <= 12 && /^en-US/i.test(locale));
      const month = monthFirst ? first : second;
      const day = monthFirst ? second : first;
      const clock = parseClock(dateTime[4]);
      if (clock) {
        const timestamp = localTimestamp(year, month, day, clock);
        if (timestamp !== null) return timestamp;
      }
    }

    const clock = parseClock(value);
    if (!clock) continue;
    const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    let dayOffset = null;
    if (/\b(?:ontem|yesterday)\b/.test(normalized)) dayOffset = -1;
    else if (/\b(?:hoje|today)\b/.test(normalized)) dayOffset = 0;
    else {
      const weekday = [...dayNames.entries()].find(([name]) => normalized.includes(name));
      if (weekday) {
        dayOffset = (weekday[1] - reference.getDay() + 7) % 7;
        if (dayOffset === 0) dayOffset = -7;
        else dayOffset -= 7;
      }
    }

    if (dayOffset !== null) {
      const date = new Date(now);
      date.setDate(date.getDate() + dayOffset);
      return localTimestamp(date.getFullYear(), date.getMonth() + 1, date.getDate(), clock);
    }
    if (/^\s*(?:\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|(?:hoje|today)\s+(?:às?\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*$/i.test(value)) {
      return localTimestamp(reference.getFullYear(), reference.getMonth() + 1, reference.getDate(), clock);
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

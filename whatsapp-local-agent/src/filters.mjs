const ORDER_INTENT = /\b(pedido|pedidos|pedir|encomenda|encomendar|comprar|compra|card[aá]pio|menu|entrega|delivery|retirada|retirar|acompanhar|rastrear|status\s+(?:do|da)\s+(?:meu\s+)?pedido|meu pedido|quero pedir)\b/i;

export function extractDirectContactId(messageId) {
  if (!messageId) return null;
  if (/@g\.us(?:_|$)/i.test(messageId)) return { group: true };
  const match = messageId.match(/(?:^|_)(\d{7,20})@(c\.us)(?:_|$)/i);
  if (!match) return null;
  return { group: false, phone: match[1], contactId: `${match[1]}@c.us` };
}

export function isOrderIntent(text) {
  return ORDER_INTENT.test(text);
}

export function classifyChoice(text) {
  const value = text.trim().toLowerCase();
  if (/^(1|fazer pedido|novo pedido|quero pedir)$/.test(value)) return "new_order";
  if (/^(2|acompanhar|acompanhar pedido|status do pedido|rastrear)$/.test(value)) return "track_order";
  return null;
}

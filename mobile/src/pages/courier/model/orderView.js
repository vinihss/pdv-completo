/**
 * Leitura tolerante dos campos de `GET /courier/deliveries`
 * (`docs/05-delivery-api-contracts.md`): `address` é STRING, a estimativa é
 * `estimatedMinutes` e as coordenadas são `addressLatitude`/`addressLongitude`
 * de topo — mas nenhum leitor pode assumir o formato, porque o payload ainda
 * ganhou campos (e o card tem que desenhar o que vier, não quebrar).
 *
 * `shortOrderId`, `estimatedText`, `orderLines` e `orderNote` são o port de
 * `frontend/src/pages/courier/model/orderView.js` (a origem deste módulo);
 * `addressText`/`deliveryDestination`/`customerName`/`customerPhone` são da
 * leitura que só o app mobile precisa (endereço e telefone no card).
 */

/** "Pedido #a1b2c3d4" — ou `null` (sem id a linha inteira some). */
export function shortOrderId(orderId) {
  const id = String(orderId ?? "").trim();
  if (!id) return null;
  return `Pedido #${id.slice(0, 8)}`;
}

/** "≈ 30 min" a partir de `estimatedMinutes`; `null` quando não vier. */
export function estimatedText(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const total = Math.round(n);
  if (total < 60) return `≈ ${total} min`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `≈ ${h} h` : `≈ ${h} h ${String(rest).padStart(2, "0")}`;
}

/**
 * Itens/notas do pedido — a informação que evita o retorno ("sem cebola").
 *
 * O formato ainda não é contrato (`items`, `orderItems` ou `order.items`; linha
 * como objeto ou como string), então o normalizador aceita todos e devolve
 * linhas prontas. Sem lista utilizável, devolve `[]` e o card não mostra a
 * seção — layout não quebra por campo a menos.
 *
 * `delivery.notes` entra com uma ressalva que não é cosmética: hoje o ÚNICO
 * writer desse campo é o `fail` (`backend` grava `status: "failed"` +
 * `notes: reason`) — ele é o MOTIVO DA FALHA. Mostrá-lo como observação do
 * pedido diria ao entregador que o cliente pediu "sem cebola" quando ele pediu
 * "cliente ausente". Num card `failed` o motivo já aparece sozinho e
 * `orderNote` devolve `null` de propósito; nos demais status nada grava o
 * campo, então lê-lo como observação é seguro.
 *
 * `.slice(0, 4)` é a única liberdade em relação ao web: no celular a lista de
 * itens do card é altura que sai da tela — mais de 4 linhas vira rolagem dentro
 * de um card que o entregador lê com uma mão.
 */
export function orderLines(delivery) {
  if (!delivery) return [];
  const raw = delivery.items ?? delivery.orderItems ?? delivery.order?.items ?? null;
  if (!Array.isArray(raw)) return [];
  const lines = raw.map(formatLine).filter(Boolean).slice(0, 4);
  const note = orderNote(delivery);
  return note ? [...lines, `OBS: ${note}`] : lines;
}

/** Observação do pedido INTEIRO (vale para todas as linhas), quando vier. */
export function orderNote(delivery) {
  const raw =
    delivery?.orderNotes ??
    delivery?.orderNote ??
    delivery?.order?.notes ??
    // `notes` da própria entrega: em `failed` é o motivo da falha (ver a nota
    // do topo do arquivo) e por isso é descartado aqui.
    (delivery?.status === "failed" ? null : delivery?.notes);
  const note = String(raw ?? "").trim();
  return note || null;
}

function formatLine(line) {
  if (typeof line === "string") return line.trim() || null;
  if (!line || typeof line !== "object") return null;
  const name = line.name ?? line.productName ?? line.title ?? null;
  if (!name) return null;
  const qty = Number(line.quantity ?? line.qty ?? 1);
  const head = Number.isFinite(qty) && qty > 1 ? `${qty}× ${name}` : String(name);
  const note = String(line.notes ?? line.observation ?? "").trim();
  return note ? `${head} — ${note}` : head;
}

/** Há endereço para desenhar? Aceita string (contrato) ou objeto. */
export function hasAddress(delivery) {
  const a = delivery?.address;
  if (typeof a === "string") return a.trim().length > 0;
  if (!a) return Boolean(delivery?.addressText);
  return Boolean(
    a.street ||
      a.number ||
      a.neighborhood ||
      a.complement ||
      a.city ||
      a.state ||
      delivery?.addressText
  );
}

/**
 * Endereço em uma linha. O contrato manda `address` como STRING; o objeto
 * (`street`/`number`/…) e o `addressText` solto são formatos que já apareceram
 * em payload — os três caem aqui, e sem nada devolve `""` (o card some com a
 * seção inteira).
 */
export function addressText(delivery) {
  const a = delivery?.address;
  if (typeof a === "string" && a.trim()) return a.trim();
  if (a && typeof a === "object") {
    const parts = [a.street, a.number, a.complement, a.neighborhood, a.city, a.state].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  if (delivery?.addressText) return String(delivery.addressText);
  return "";
}

/**
 * Coordenadas do destino para o mapa. O contrato expõe `addressLatitude`/
 * `addressLongitude` de topo; o objeto `address { latitude, longitude }` é o
 * formato que o card já aceitava. Sem georreferência, `null` — o mapa não
 * desenha marker de destino, não quebra.
 */
export function deliveryDestination(delivery) {
  const a = delivery?.address || {};
  const lat = (typeof a === "object" ? a.latitude : null) ?? delivery?.addressLatitude;
  const lng = (typeof a === "object" ? a.longitude : null) ?? delivery?.addressLongitude;
  if (lat == null || lng == null) return null;
  const nlat = Number(lat);
  const nlng = Number(lng);
  if (Number.isNaN(nlat) || Number.isNaN(nlng)) return null;
  return { latitude: nlat, longitude: nlng };
}

export function customerName(delivery) {
  return delivery?.customerName || delivery?.customer?.name || "Cliente";
}

export function customerPhone(delivery) {
  return delivery?.customerPhone || delivery?.customer?.phone || delivery?.customer?.phoneNumber || null;
}

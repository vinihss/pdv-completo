/**
 * Leitura tolerante dos campos novos de `GET /courier/deliveries`.
 *
 * Tudo aqui tem fallback: a mudança de payload é de outro agente e pode não
 * estar no mesmo branch, então nenhum leitor pode assumir que o campo existe —
 * no máximo, que quando ele chegar a tela não precisa de outro ajuste.
 */

/** "Pedido #a1b2c3d4" — ou `null` (sem `orderId` a linha inteira some). */
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
 * writer desse campo é `failDeliveryUsecase`
 * (`backend/src/application/self-service/delivery.usecases.ts`:
 * `.set({ status: "failed", notes: input.reason })`) — ele é o MOTIVO DA FALHA.
 * Mostrá-lo como observação do pedido diria ao entregador que o cliente pediu
 * "sem cebola" quando ele pediu "cliente ausente". Numa entrega `failed` o card
 * de problema já mostra o motivo e `orderNote` devolve `null` de propósito; nos
 * demais status nada grava o campo, então lê-lo como observação é seguro — e é o
 * que faz a observação aparecer assim que o outro agente começar a gravá-la.
 *
 * `courier: { id, name }` do contrato NÃO é lido aqui, de propósito: esta é a
 * tela do próprio entregador, então o nome da coluna é sempre "eu". Só teria
 * quem lê para outro — e isso é o card do gerente, não este.
 */
export function orderLines(delivery) {
  if (!delivery) return [];
  const raw = delivery.items ?? delivery.orderItems ?? delivery.order?.items ?? null;
  if (!Array.isArray(raw)) return [];
  const lines = raw.map(formatLine).filter(Boolean);
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
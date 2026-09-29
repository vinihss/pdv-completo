// Rótulos e apresentação da central de alertas. Funções puras (testáveis sem
// DOM e sem rede) — o componente só desenha o que sai daqui.

/** "agora", "há 4 min", "há 2 h", "ontem 21:40"… */
export function alertAgeLabel(createdAt, now = Date.now()) {
  const ms = now - new Date(createdAt).getTime();
  if (Number.isNaN(ms)) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "ontem" : `há ${days} dias`;
}

const CHANNEL_HINT = {
  balcao: "Comanda",
  web: "Pedido online",
  whatsapp: "WhatsApp",
  ifood: "iFood",
};

/**
 * Linha secundária: o `body` que o backend montou ("Entrega · página",
 * "iFood 1234") e, à falta dele, o canal. Fica `null` quando não há nada a
 * dizer — o componente não desenha linha vazia.
 */
export function alertSubtitle(alert) {
  if (alert.body) return alert.body;
  const hint = CHANNEL_HINT[alert.channel];
  return hint && hint !== alert.channel ? hint : null;
}

/**
 * Dá para navegar a partir do alerta? Só com comanda ABERTA e para quem tem a
 * tela de comandas. Os demais (caixa, cozinha, entregador) e as comandas já
 * fechadas só marcam como lido — abrir um pedido de delivery na tela de
 * cashier não tem para onde.
 */
export function canOpenAlert(alert, role) {
  if (!alert?.orderId) return false;
  if (alert.orderStatus !== "open") return false;
  return role === "manager" || role === "waiter";
}

/**
 * Agrupa por dia ("Hoje", "Ontem", "12/09") preservando a ordem (mais recente
 * primeiro dentro do grupo). A lista do sino é curta, então a forma é a de
 * quebrar em linhas com um separador — sem `Intl.DateTimeFormat` por item.
 */
export function groupAlertsByDay(alerts, now = Date.now()) {
  const dayStart = (ts) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = dayStart(now);
  const yesterday = today - 86_400_000;
  const groups = [];
  for (const alert of alerts) {
    const ts = new Date(alert.createdAt).getTime();
    const key = dayStart(ts);
    const label =
      key === today
        ? "Hoje"
        : key === yesterday
        ? "Ontem"
        : new Date(key).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(alert);
    else groups.push({ label, items: [alert] });
  }
  return groups;
}

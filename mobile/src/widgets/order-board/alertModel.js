// Alertas do fluxo do garçom (sino). Porta de frontend/src/entities/alert
// ({api/alerts.js, model/alertView.js}) para o módulo do garçom.

import { request } from "@/shared/api/http";
import { storage } from "@/shared/lib/storage";

export function listAlerts({ limit, unreadOnly } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (unreadOnly) params.set("unread_only", "true");
  const qs = params.toString();
  return request("GET", `/alerts${qs ? `?${qs}` : ""}`);
}

export function markAlertsRead(orderId) {
  return request("POST", "/alerts/mark-read", orderId ? { orderId } : {});
}

// Rótulo relativo ("agora", "há 4 min", "ontem 21:40"…) — pure, testável.
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

export function alertSubtitle(alert) {
  if (alert.body) return alert.body;
  const hint = CHANNEL_HINT[alert.channel];
  return hint && hint !== alert.channel ? hint : null;
}

/** Dá para navegar a partir do alerta? Só comanda ABERTA e p/ garçom/gerente. */
export function canOpenAlert(alert, role) {
  if (!alert?.orderId) return false;
  if (alert.orderStatus !== "open") return false;
  return role === "manager" || role === "waiter";
}

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
      key === today ? "Hoje" : key === yesterday ? "Ontem" : new Date(key).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(alert);
    else groups.push({ label, items: [alert] });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Preferência de som por dispositivo (mesma chave do web: "pdv:alert-sound")
// ---------------------------------------------------------------------------

export const ALERT_SOUND_KEY = "pdv:alert-sound";
export const ALERT_REPEAT_MS = 30_000;

export function isAlertSoundEnabled() {
  try {
    return storage.getItem(ALERT_SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAlertSoundEnabled(enabled) {
  try {
    storage.setItem(ALERT_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    /* storage indisponível: o som funciona, só não persiste */
  }
  return enabled;
}
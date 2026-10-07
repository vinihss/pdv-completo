// Fonte do sino de alertas do garçom — porta de
// frontend/src/app/providers/alerts/AlertsProvider.jsx restrita ao fluxo de
// comandas (rooms `alerts` + `alerts:waiter`). Mesmas regras do web:
// server-authoritative (o badge vem do `unread` de GET /alerts; o
// `alert.created` do WS só MOVE a lista local), reload na reconexão e na
// volta do background, e repetição do som a cada 30s enquanto houver alerta
// não lido.
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/providers/auth";
import { useRealtime, useAppStateActive } from "@/shared/hooks";
import { playAlertBeep } from "@/features/orders/lib/alertSound";
import { ALERT_REPEAT_MS, isAlertSoundEnabled, listAlerts, markAlertsRead, setAlertSoundEnabled } from "./alertModel.js";

const LIST_LIMIT = 20;

export function useAlertsBox() {
  const { session } = useAuth();
  const [alerts, setAlerts] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(() => isAlertSoundEnabled());
  const [open, setOpen] = useState(false);

  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const seenIds = useRef(new Set());
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const repeatTimers = useRef(new Map());

  const reload = useCallback(async () => {
    try {
      const res = await listAlerts({ limit: LIST_LIMIT });
      const data = res.data ?? [];
      seenIds.current = new Set(data.map((a) => a.id));
      setAlerts(data);
      setUnreadCount(res.unread ?? 0);
    } catch {
      /* sem rede / token expirado: o próximo reload tenta de novo */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      seenIds.current = new Set();
      setAlerts([]);
      setUnreadCount(0);
      return;
    }
    setLoading(true);
    reload();
  }, [session, reload]);

  // Voltar do background reconta (o WS não tem buffer de eventos perdidos).
  useAppStateActive(() => {
    if (session) reload();
  });

  const scheduleRepeat = useCallback((alert) => {
    if (repeatTimers.current.has(alert.id)) return;
    const timer = setTimeout(() => {
      repeatTimers.current.delete(alert.id);
      const stillUnread = alertsRef.current.some((a) => a.id === alert.id && !a.readAt);
      if (stillUnread && soundEnabledRef.current) playAlertBeep();
    }, ALERT_REPEAT_MS);
    repeatTimers.current.set(alert.id, timer);
  }, []);

  const cancelRepeat = useCallback((alertId) => {
    const timer = repeatTimers.current.get(alertId);
    if (timer) {
      clearTimeout(timer);
      repeatTimers.current.delete(alertId);
    }
  }, []);

  const fire = useCallback(
    (alert) => {
      if (seenIds.current.has(alert.id)) return false;
      seenIds.current.add(alert.id);
      setAlerts((prev) => [alert, ...prev]);
      if (alert.readAt) return true;
      setUnreadCount((n) => n + 1);
      if (soundEnabledRef.current) playAlertBeep();
      scheduleRepeat(alert);
      return true;
    },
    [scheduleRepeat]
  );

  const handleEvent = useCallback(
    (msg) => {
      if (msg.type !== "alert.created" || !msg.payload) return;
      fire(msg.payload);
    },
    [fire]
  );

  const handleReconnect = useCallback(() => {
    if (session) reload();
  }, [session, reload]);

  const rooms = session ? ["alerts", `alerts:${session.user.role}`] : [];
  useRealtime(session?.token, rooms, handleEvent, handleReconnect);

  // Nenhum timer pode vazar para a sessão seguinte.
  useEffect(() => {
    return () => {
      for (const timer of repeatTimers.current.values()) clearTimeout(timer);
      repeatTimers.current.clear();
    };
  }, [session?.user?.id]);

  const markRead = useCallback(
    async (orderId) => {
      setAlerts((prev) =>
        prev.map((a) => (!a.readAt && (!orderId || a.orderId === orderId) ? { ...a, readAt: new Date().toISOString() } : a))
      );
      setUnreadCount((n) => (orderId ? n : 0));
      for (const a of alertsRef.current) {
        if (!a.readAt && (!orderId || a.orderId === orderId)) cancelRepeat(a.id);
      }
      try {
        const res = await markAlertsRead(orderId);
        if (!orderId || res?.marked > 0) {
          const fresh = await listAlerts({ limit: 1 });
          setUnreadCount(fresh.unread ?? 0);
        }
      } catch {
        reload();
      }
    },
    [reload, cancelRepeat]
  );

  const openAlert = useCallback(
    (alert) => {
      cancelRepeat(alert.id);
      return markRead(alert.orderId);
    },
    [markRead, cancelRepeat]
  );

  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = setAlertSoundEnabled(!prev);
      if (next) playAlertBeep();
      return next;
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const openPanel = useCallback(() => {
    if (session) reload();
    setOpen(true);
  }, [session, reload]);

  return { alerts, unreadCount, loading, soundEnabled, open, openPanel, close, toggleSound, markRead, openAlert };
}
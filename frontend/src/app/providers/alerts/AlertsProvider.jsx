import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { useToast } from "@/shared/components";
import { unlockAudio } from "@/shared/lib/audio";
import {
  listAlerts,
  markAlertsRead,
  playAlertSound,
  isAlertSoundEnabled,
  setAlertSoundEnabled,
  ALERT_REPEAT_MS,
} from "@/entities/alert";

const LIST_LIMIT = 20;

/**
 * Estado da central de alertas. Fica no `app/` porque é o único estado que
 * atravessa a casca (o sino) e a página (a comanda que abre) — irmãs na
 * árvore, sem prop que atravesse. Mesma razão do `NavProvider`.
 *
 * O backend é dono (server-authoritative, sem lib de estado): o contador vem do
 * `unread` de `GET /alerts` e o `alert.created` do WebSocket só MOVE a lista
 * local — nunca conta sozinho.
 *
 * Um alarme que perde o evento é pior que um alarme atrasado, e o evento se
 * perde de verdade: o dispatcher do outbox marca a publicação como feita mesmo
 * quando a sala não tem assinante. Por isso a lista recarrega em DOIS momentos
 * que não são o carregamento inicial — ao voltar o foco da aba e ao reconectar
 * o WebSocket (`onReconnect` do `useRealtime`). É o substituto barato do
 * buffer de eventos do roadmap 4.3.
 */
const AlertsContext = createContext(null);

export function AlertsProvider({ children }) {
  const { session } = useAuth();
  const { toast, showToast } = useToast();
  const [alerts, setAlerts] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(() => isAlertSoundEnabled());

  // Ref e não estado para o timer de repetição: o timer precisa ler o estado
  // mais recente no disparo, sem ser recriado (e o som repetido) a cada render.
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  // Ids já conhecidos: o `alert.created` reconta o badge só na primeira vez.
  // Precisa ser um Set à parte do estado porque o evento pode chegar repetido
  // (reconnect reentrega o outbox) e o `setAlerts` sozinho não impediria o
  // `unreadCount` de subir duas vezes.
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
      /* sem rede / token expirado: o próximo reload (foco da aba) tenta de novo */
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

  // ---------- som ----------

  const sound = useCallback((kind) => {
    if (!soundEnabledRef.current) return;
    playAlertSound(kind);
  }, []);

  const scheduleRepeat = useCallback(
    (alert) => {
      // Um timer por alerta: dois pedidos no mesmo minuto tocam duas vezes no
      // segundo ciclo, não uma vez só.
      if (repeatTimers.current.has(alert.id)) return;
      const timer = setTimeout(() => {
        repeatTimers.current.delete(alert.id);
        const stillUnread = alertsRef.current.some((a) => a.id === alert.id && !a.readAt);
        if (stillUnread) sound(alert.kind);
      }, ALERT_REPEAT_MS);
      repeatTimers.current.set(alert.id, timer);
    },
    [sound]
  );

  const cancelRepeat = useCallback((alertId) => {
    const timer = repeatTimers.current.get(alertId);
    if (timer) {
      clearTimeout(timer);
      repeatTimers.current.delete(alertId);
    }
  }, []);

  // Um timer pendente não pode vazar para a sessão seguinte: logout com a aba
  // no meio dos 30s tocaria o som do usuário que entrou em seguida.
  const userId = session?.user?.id;
  useEffect(() => {
    const timers = repeatTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [userId]);

  const handleEvent = useCallback(
    (msg) => {
      if (msg.type !== "alert.created" || !msg.payload) return;
      const alert = msg.payload;
      // Reconexão pode reentregar o que o outbox guardou: o mesmo id não vira
      // duas linhas, não soma duas no badge e não toca o som duas vezes.
      if (seenIds.current.has(alert.id)) return;
      seenIds.current.add(alert.id);
      setAlerts((prev) => [alert, ...prev]);
      if (alert.readAt) return;
      setUnreadCount((n) => n + 1);
      showToast(alert.body ? `${alert.title} · ${alert.body}` : alert.title);
      sound(alert.kind);
      scheduleRepeat(alert);
    },
    [showToast, sound, scheduleRepeat]
  );

  // Reconexão: o `alert.created` emitido enquanto a conexão estava fora não
  // volta (o outbox já marcou como publicado), então quem reconecta recarrega.
  const handleReconnect = useCallback(() => {
    if (session) reload();
  }, [session, reload]);

  const rooms = session ? ["alerts", `alerts:${session.user.role}`] : [];
  useRealtime(session?.token, rooms, handleEvent, handleReconnect);

  // O WS não tem buffer de eventos perdidos (roadmap 4.3): ao voltar pra aba o
  // REST é quem reconta.
  useEffect(() => {
    if (!session || typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [session, reload]);

  // ---------- marcar lido ----------

  const markRead = useCallback(
    async (orderId) => {
      // Otimista: o badge cai na hora e a repetição desarma. O servidor confirma
      // (e o erro volta no próximo reload) — um alarme não espera a rede.
      setAlerts((prev) =>
        prev.map((a) =>
          !a.readAt && (!orderId || a.orderId === orderId) ? { ...a, readAt: new Date().toISOString() } : a
        )
      );
      // Com `orderId` só some o alerta daquela comanda — quantos eram é
      // informação do servidor (pode ser mais de um), então o contador local
      // fica como está e é reconciliado na resposta.
      setUnreadCount((n) => (orderId ? n : 0));
      // A tela da comanda marca lido sem passar pelo sino: sem isso o timer de
      // 30s ficaria armado até o fim (mudo, porque o estado já está lido).
      for (const a of alertsRef.current) {
        if (!a.readAt && (!orderId || a.orderId === orderId)) cancelRepeat(a.id);
      }
      try {
        const res = await markAlertsRead(orderId);
        // `marked: 0` = nada mudou (comanda sem alerta, ou já lido): o contador
        // local já está certo e o refetch seria uma ida ao banco à toa.
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

  // Clique/toque no alerta. Com comanda, é a regra "abriu a comanda, leu o
  // alerta". Sem `orderId` (alerta público de outro tipo, no futuro) o
  // endpoint só sabe marcar tudo — é o que sobra, e o comentário no backend
  // registra a lacuna.
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
      // Ligar o som só faz sentido audível: dá um bipe de confirmação.
      if (next) playAlertSound("order_created");
      return next;
    });
  }, []);

  // Autoplay policy: nada de som antes do primeiro gesto do usuário. Um único
  // listener em toda a casca (não só no sino) destrava o `AudioContext` no
  // primeiro toque em qualquer botão — inclusive no "Entrar" do login.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const unlock = () => {
      unlockAudio();
    };
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  const value = useMemo(
    () => ({
      alerts,
      unreadCount,
      loading,
      toast,
      soundEnabled,
      toggleSound,
      reload,
      markRead,
      openAlert,
    }),
    [alerts, unreadCount, loading, toast, soundEnabled, toggleSound, reload, markRead, openAlert]
  );

  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export function useAlerts() {
  const ctx = useContext(AlertsContext);
  if (!ctx) throw new Error("useAlerts precisa estar dentro de <AlertsProvider>");
  return ctx;
}

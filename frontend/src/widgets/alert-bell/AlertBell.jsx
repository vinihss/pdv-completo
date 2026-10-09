import React from "react";
import { createPortal } from "react-dom";
import { Bell, BellRing } from "lucide-react";
import { useAlerts } from "@/app/providers/alerts";
import { useOrderFocus } from "@/app/providers/order-focus";
import { useAuth } from "@/app/providers/auth";
import { Toast } from "@/shared/components";
import { canOpenAlert } from "@/entities/alert";
import AlertList from "./AlertList.jsx";

/**
 * Estado "online" do navegador (navigator.onLine + eventos online/offline).
 *
 * É o único sinal de conexão observável sem mexer no `useRealtime`: cobre
 * o caso extremo de "sem sinal nenhum", quando o usuário precisa saber que
 * a tela mostra dados de antes da queda.
 */
function useNetworkOnline() {
  const [online, setOnline] = React.useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false
  );
  React.useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * LED indicador de conexão. Verde = online, vermelho = offline.
 * Posicionado no canto superior direito do sino (padrão de indicadores de
 * status) — antes ficava no canto inferior esquerdo, que competia com o
 * badge de contagem e destoava do padrão visual.
 * Tooltip nativo (title) com a mensagem em PT-BR.
 */
function ConnectionLed({ online }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-stone-900"
      style={{ backgroundColor: online ? "#22c55e" : "#ef4444", transition: "background-color 150ms ease" }}
      title={online ? "Conectado ao servidor" : "Sem conexao com o servidor"}
    />
  );
}

/**
 * Sino do header, com o contador de não visualizados e o LED de conexão.
 * Vive na casca (`app/router.jsx`) porque é o header — e não uma página —
 * que o desenha nos 5 perfis.
 *
 * O sino é visível para todo mundo, mesmo para quem (hoje: o garçom) não tem
 * audiência em nenhum alerta — a central vazia é informação ("nada chegou pra
 * você") e o toggle de som fica sempre ao alcance.
 *
 * O drawer e o toast saem por portal para o `document.body`: o header tem
 * `backdrop-blur`, e um ancestral com `filter`/`backdrop-filter` vira containing
 * block de `position: fixed` — sem o portal, o `Drawer` (que é `fixed inset-0`)
 * ficaria preso na faixa de 56px do header em vez de cobrir a tela.
 */
export default function AlertBell() {
  const { session } = useAuth();
  const { alerts, unreadCount, loading, toast, soundEnabled, toggleSound, markRead, openAlert } = useAlerts();
  const { focusOrder } = useOrderFocus();
  const [open, setOpen] = React.useState(false);
  const online = useNetworkOnline();

  function handleSelect(alert) {
    // Marca lido sempre (é a regra do alerta) e abre a comanda só quando faz
    // sentido para este papel: caixa/cozinha/entregador não têm a tela de
    // comandas, e comanda já encerrada não tem o que abrir.
    openAlert(alert);
    if (canOpenAlert(alert, session?.user?.role)) {
      focusOrder(alert.orderId);
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unreadCount > 0 ? `Alertas (${unreadCount} não lidos)` : "Alertas"}
        aria-expanded={open}
        aria-controls="alert-bell-painel"
        className="relative w-10 h-10 -mr-1 flex items-center justify-center rounded-full text-stone-300 hover:text-amber-300 transition-colors shrink-0"
      >
        {unreadCount > 0 ? <BellRing size={20} /> : <Bell size={20} />}
        {unreadCount > 0 && (
          <span
            data-testid="alert-badge"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-stone-950 text-[11px] font-bold flex items-center justify-center"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
        <ConnectionLed online={online} />
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <>
            <AlertList
              open={open}
              onClose={() => setOpen(false)}
              alerts={alerts}
              loading={loading}
              unreadCount={unreadCount}
              soundEnabled={soundEnabled}
              onToggleSound={toggleSound}
              onMarkAll={() => markRead()}
              onSelect={handleSelect}
            />
            <Toast toast={toast} />
          </>,
          document.body
        )}
    </>
  );
}

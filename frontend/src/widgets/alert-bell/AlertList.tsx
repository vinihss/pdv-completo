import { alertAgeLabel, alertSubtitle, groupAlertsByDay } from "@/entities/alert";
import { Drawer } from "@/shared/components";
import { BellOff, CheckCheck, X } from "lucide-react";
import React from "react";

/**
 * Drawer da central de alertas: a lista do que chegou no salão, o que ainda não
 * foi visto e o botão de som. Owner do overlay é o `Drawer` (painel pela
 * direita) — nada de `fixed inset-0` ad hoc aqui.
 *
 * A lista é agrupada por dia e mostra as lidas também (o sino é histórico do
 * turno, não fila de trabalho): o que separa as duas é o peso da linha e o
 * ponto de "lida", não a ausência.
 */
export default function AlertList({
  open,
  onClose,
  alerts,
  loading,
  unreadCount,
  soundEnabled,
  onToggleSound,
  onMarkAll,
  onSelect,
}) {
  const groups = React.useMemo(() => groupAlertsByDay(alerts), [alerts]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      panelId="alert-bell-painel"
      panelClassName="w-full sm:w-96"
      label="Alertas"
    >
      <header className="h-14 shrink-0 flex items-center gap-2 px-4 border-b border-border">
        <h2 className="text-sm font-semibold text-text-secondary flex-1 min-w-0 truncate">
          Alertas
          {unreadCount > 0 && <span className="ml-1.5 text-primary">{unreadCount} não lidos</span>}
        </h2>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={onMarkAll}
            title="Marcar todas como lidas"
            aria-label="Marcar todas como lidas"
            className="text-text-secondary hover:text-foreground text-xs font-semibold flex items-center gap-1 transition-colors"
          >
            <CheckCheck size={16} />
            Marcar todas
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Fechar alertas"
          aria-label="Fechar alertas"
          className="w-9 h-9 -mr-1 flex items-center justify-center rounded-full text-text-secondary hover:text-foreground transition-colors"
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading && alerts.length === 0 && (
          <p className="p-4 text-sm text-text-muted">Carregando…</p>
        )}
        {!loading && alerts.length === 0 && (
          <p className="p-4 text-sm text-text-muted">Nada por aqui ainda.</p>
        )}
        {groups.map((group) => (
          <section key={group.label}>
            <h3 className="px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-text-muted sticky top-0 bg-background/95 backdrop-blur border-b border-border/60">
              {group.label}
            </h3>
            <ul>
              {group.items.map((alert) => {
                const read = Boolean(alert.readAt);
                const subtitle = alertSubtitle(alert);
                return (
                  <li key={alert.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(alert)}
                      className={`w-full text-left px-4 py-3 border-b border-border/60 flex gap-3 transition-colors ${
                        read ? "opacity-60" : "hover:bg-surface/70"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
                          read ? "bg-surface-overlay" : "bg-primary"
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block text-sm ${read ? "text-text-secondary" : "text-foreground font-semibold"}`}
                        >
                          {alert.title}
                        </span>
                        {subtitle && (
                          <span className="block text-xs text-text-muted mt-0.5">{subtitle}</span>
                        )}
                        <span className="block text-[11px] text-text-muted mt-1">
                          {alertAgeLabel(alert.createdAt)}
                          {read && " · lida"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <footer className="shrink-0 border-t border-border p-3">
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={soundEnabled}
            onChange={onToggleSound}
            className="w-4 h-4 accent-amber-500"
          />
          <BellOff size={16} className={soundEnabled ? "text-text-muted" : "text-text-muted"} />
          {soundEnabled ? "Som ligado" : "Som desligado"}
        </label>
        <p className="mt-1 text-[11px] text-text-muted">
          O som toca de novo enquanto o alerta continuar não lido. A preferência vale neste
          aparelho.
        </p>
      </footer>
    </Drawer>
  );
}

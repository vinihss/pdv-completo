// Estado do sino elevado para o escopo do fluxo do garçom — irmãs na árvore,
// como no web (`app/providers/alerts/AlertsProvider.jsx`): o sino (casca, no
// header do Board) e a tela da comanda precisam da MESMA fonte, senão a
// comanda aberta não consegue descontar o alerta que ela acaba de atender.
// Porta do `AlertsProvider` web restrita ao fluxo (o hook continua em
// `useAlertsBox.js`; aqui é só a fronteira de contexto).
import { createContext, useContext } from "react";
import { useAlertsBox } from "./useAlertsBox.js";

const AlertsBoxContext = createContext(null);

export function AlertsBoxProvider({ children }) {
  const box = useAlertsBox();
  return <AlertsBoxContext.Provider value={box}>{children}</AlertsBoxContext.Provider>;
}

/**
 * Caixa de alertas compartilhada. Exige `<AlertsBoxProvider>` por perto:
 * AlertBell e OrderDetailScreen são irmãs no stack do GarconFlowStub, e
 * criar uma caixa por componente duplicaria rooms/realtime/timers de som.
 */
export function useAlertsBoxContext() {
  const ctx = useContext(AlertsBoxContext);
  if (!ctx) throw new Error("useAlertsBoxContext precisa estar dentro de <AlertsBoxProvider>");
  return ctx;
}

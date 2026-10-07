// Substituto RN de `document.visibilitychange` (frontend uses
// `document.addEventListener("visibilitychange", …)` para recarregar estado
// ao voltar para a aba). No app, "voltar para a aba" é o app voltando ao
// FOREGROUND: `AppState` vira "active".
//
// Sem buffer de eventos perdidos no WS, voltar do background é o momento em
// que se descobre que um evento se foi — quem usa o hook recarrega por GET
// ali, mesmo padrão do web.

import { useEffect, useRef } from "react";
import { AppState } from "react-native";

/**
 * Chama `callback` quando o app volta ao foreground (background → active).
 * A montagem NÃO dispara: quem usa já carregou por GET, como no web.
 */
export function useAppStateActive(callback) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    let prev = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && prev !== null && prev !== "active") {
        cbRef.current?.();
      }
      prev = next;
    });
    return () => sub.remove();
  }, []);
}
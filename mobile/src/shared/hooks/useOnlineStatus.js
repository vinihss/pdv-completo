// Substituto RN de `navigator.onLine` (frontend usa `online`/`offline`
// events). No app, a fonte da verdade é o `@react-native-community/netinfo`,
// que enxerga o estado real das interfaces (Wi-Fi/serial) e dispara no
// fallback do SO.

import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

/**
 * True quando há conexão de rede. Sinal grosseiro (a Internet pode não estar
 * disponível mesmo com interface up) — para estado fino quem responde é o
 * próprio useRealtime.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false);
    });
    return unsubscribe;
  }, []);

  return online;
}
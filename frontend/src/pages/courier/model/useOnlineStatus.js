import { useEffect, useState } from "react";

/**
 * O SO está avisando que não há rede?
 *
 * É o único sinal de "conexão" que a tela consegue observar sem mexer no
 * `useDeliveries`: ele não expõe o estado do WebSocket, então queda de socket
 * em 4G de rua é invisível por aqui (o hook recarrega sozinho quando volta —
 * `useRealtime(token, rooms, reload, reload)`). `navigator.onLine` pelo menos
 * cobre o caso extremo de "sem sinal nenhum", que é quando o entregador precisa
 * saber que a lista que ele vê é a última conhecida.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
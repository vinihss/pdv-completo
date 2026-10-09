import { useState, useEffect } from "react";

/**
 * Hook que detecta se o navegador está online ou offline.
 * Usa a API navigator.onLine e escuta eventos 'online'/'offline'.
 * Retorna { isOnline: boolean }.
 */
export default function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }

    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return { isOnline };
}

import { useEffect } from "react";

/**
 * Tela ligada enquanto o app está em primeiro plano.
 *
 * O entregador navega entre o app e o Google Maps o dia inteiro; com o
 * descanso de tela no meio do trajeto, a tela volta em "entregue?" ou, pior,
 * o SO mata o app e o `useRealtime` reconecta sozinho mas a lista fica parada
 * até ele reabrir. Wake Lock segura isso sem custo de energia relevante
 * enquanto há app aberto.
 *
 * Tudo aqui é degradação silenciosa por definição: `navigator.wakeLock` não
 * existe em iOS Safari nem em webview antiga, e o pedido pode ser negado pelo
 * SO (bateria baixa, tela apagada à força). Nenhum desses casos pode virar
 * erro de tela — quem usa o app não vê, quem programa o app não recebe
 * exceção.
 */
export function useScreenWakeLock() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.wakeLock?.request) return;

    let sentinel = null; // o handle do lock; null = não há lock na mão

    async function acquire() {
      try {
        sentinel = await navigator.wakeLock.request("screen");
        sentinel.addEventListener?.("release", () => {
          sentinel = null;
        });
      } catch {
        sentinel = null;
      }
    }

    // O SO solta o lock quando a aba vai para background (e o navegador
    // também, ao trocar de aba): reidratar é o contrato do Wake Lock API.
    function onVisibility() {
      if (document.visibilityState === "visible" && !sentinel) acquire();
    }

    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release?.().catch?.(() => {});
      sentinel = null;
    };
  }, []);
}
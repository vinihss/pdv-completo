import { useEffect } from "react";

/**
 * Trava o scroll do fundo enquanto um overlay existe e devolve o valor
 * anterior no unmount. Overlays aninhados (um Modal aberto de dentro do
 * Drawer) compostam: o de baixo salva "hidden" e devolve "hidden".
 */
export default function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

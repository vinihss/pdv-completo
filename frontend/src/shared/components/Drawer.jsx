import React from "react";
import useEscapeLayer from "@/shared/hooks/useEscapeLayer.js";
import useBodyScrollLock from "@/shared/hooks/useBodyScrollLock.js";
import useFocusTrap from "@/shared/hooks/useFocusTrap.js";

const SIDE_CLASS = { left: "left-0 slide-in-left", right: "right-0 slide-in-right" };

/**
 * Overlay lateral: um painel que entra deslizando pela esquerda (ou direita)
 * sobre um scrim, para o que é navegação — o menu principal no celular. É o
 * irmão do `Modal` (que é tela cheia) e do `ConfirmModal` (que é card
 * centralizado): os três dividem os mesmos contratos, Esc pela pilha de
 * camadas, trava de scroll do fundo e focus trap.
 *
 * `open` controla a montagem: fechado, não renderiza nada, não registra
 * camada de Esc e não trava o scroll do fundo. Só a entrada é animada (o
 * `Modal` também não tem animação de saída).
 */
export default function Drawer({ open, onClose, side = "left", panelId, panelClassName = "", label, children }) {
  const layerRef = useEscapeLayer(open ? onClose : undefined);
  useBodyScrollLock(open);
  useFocusTrap(layerRef, open);

  if (!open) return null;

  return (
    <div ref={layerRef} className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden="true" />
      <div
        id={panelId}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`absolute inset-y-0 flex flex-col bg-stone-950 border-stone-800 shadow-2xl ${SIDE_CLASS[side] ?? SIDE_CLASS.left} ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

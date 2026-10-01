import React, { useRef, useState, useEffect } from "react";
import { X } from "lucide-react";
import useEscapeLayer from "@/shared/hooks/useEscapeLayer.js";
import useBodyScrollLock from "@/shared/hooks/useBodyScrollLock.js";
import useFocusTrap from "@/shared/hooks/useFocusTrap.js";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Arrastar para baixo fecha. Os limiares são generosos de propósito: o dedo
// precisa de intenção clara, senão um scroll nervoso derruba o formulário.
const CLOSE_DISTANCE = 120; // arrasto longo e deliberado
const FLICK_DISTANCE = 40; // below this it is a micro-adjustment, not a flick
const CLOSE_VELOCITY = 0.6; // px/ms — " flick " curto
const AXIS_LOCK = 8; // px antes de travar o eixo do gesto (vertical x diagonal)

/**
 * Modal de tela cheia: cabeçalho fixo com título e X à direita, corpo rolável
 * e rodapé opcional (botão de ação sempre visível, sem precisar rolar até o
 * fim de um formulário longo). Fica 100% em qualquer device — o tablet do
 * garçom é o alvo, e "tela cheia" dispensa backdrop e cantos.
 *
 * Fecha de três formas: X, tecla Esc e arrastando para baixo (no touch).
 * `footer` recebe os botões de ação; `headerRight` um ícone extra (imprimir).
 */
export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  headerRight,
  ariaLabel,
}) {
  const bodyRef = useRef(null);
  const gesture = useRef(null);
  const [dragY, setDragY] = useState(null);

  // Esc: registrado na pilha de camadas (shared/hooks/useEscapeLayer), então
  // só a camada de cima reage — um Modal sobre a comanda não fecha os dois.
  const layerRef = useEscapeLayer(onClose);

  // Trava o scroll do fundo enquanto o modal existe (não havia nada disso no
  // app: o body rolava por trás dos overlays) e prende/restaura o foco.
  useBodyScrollLock();
  useFocusTrap(layerRef);

  // Focus trap + restauração de foco: Tab/Shift+Tab ficam dentro do modal e o
  // foco retorna ao elemento que abriu ao fechar.
  useEffect(() => {
    const node = layerRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement;
    const focusables = () => Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = focusables()[0];
    if (first) first.focus();

    function handleKeyDown(e) {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || !node.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !node.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [layerRef]);

  function handleTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    gesture.current = { x: t.clientX, y: t.clientY, dy: 0, t0: Date.now(), locked: false };
  }

  function handleTouchMove(e) {
    const g = gesture.current;
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dy = t.clientY - g.y;
    const dx = t.clientX - g.x;

    if (!g.locked) {
      if (Math.abs(dy) < AXIS_LOCK && Math.abs(dx) < AXIS_LOCK) return;
      // Diagonal é scroll/navegação, não descarte.
      if (Math.abs(dx) > Math.abs(dy)) return void (gesture.current = null);
      // Para cima ou com o corpo já rolado, quem responde é o scroll nativo.
      if (dy < 0 || (bodyRef.current && bodyRef.current.scrollTop > 0)) {
        return void (gesture.current = null);
      }
      g.locked = true;
    }

    g.dy = dy;
    setDragY(dy);
  }

  function handleTouchEnd() {
    const g = gesture.current;
    gesture.current = null;
    if (!g || !g.locked) return;
    const velocity = g.dy / Math.max(Date.now() - g.t0, 1);
    setDragY(null);
    const flicked = g.dy > FLICK_DISTANCE && velocity > CLOSE_VELOCITY;
    if (g.dy > CLOSE_DISTANCE || flicked) onClose();
  }

  return (
    <div ref={layerRef} className="fixed inset-0 z-50 bg-stone-950">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        className={`h-full flex flex-col bg-stone-950 fade-up ${
          dragY === null ? "transition-transform duration-200" : ""
        }`}
        style={dragY === null ? undefined : { transform: `translateY(${dragY}px)` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <header className="shrink-0 flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 border-b border-stone-800 bg-stone-950/95 backdrop-blur">
          <div className="flex-1 min-w-0">
            {title && <h2 className="font-display text-lg font-bold leading-tight truncate">{title}</h2>}
            {subtitle && <p className="text-stone-500 text-xs truncate">{subtitle}</p>}
          </div>
          {headerRight}
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="w-10 h-10 -mr-2 flex items-center justify-center rounded-full text-stone-500 hover:text-stone-200 transition-colors shrink-0"
          >
            <X size={20} />
          </button>
        </header>

        <div ref={bodyRef} className="flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>

        {footer && (
          <div className="shrink-0 border-t border-stone-800 bg-stone-950/95 backdrop-blur px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

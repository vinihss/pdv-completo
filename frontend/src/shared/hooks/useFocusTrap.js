import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus trap + restauração de foco: Tab/Shift+Tab ficam dentro do overlay e o
 * foco volta para o elemento que o abriu quando ele sai. `active` existe
 * porque o `Drawer` é montado condicionalmente — sem ele o efeito não
 * reinstalaria o trap quando `open` virasse true (o ref do nó só existe a
 * partir do render em que o painel aparece).
 */
export default function useFocusTrap(nodeRef, active = true) {
  useEffect(() => {
    const node = nodeRef.current;
    if (!active || !node) return;
    const previouslyFocused = document.activeElement;
    const focusables = () =>
      Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
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
      const active_ = document.activeElement;
      if (e.shiftKey && (active_ === firstEl || !node.contains(active_))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active_ === lastEl || !node.contains(active_))) {
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
  }, [nodeRef, active]);
}

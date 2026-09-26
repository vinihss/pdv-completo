import { useEffect, useRef } from "react";

/**
 * Pilha de camadas de Esc. Existe porque `stopImmediatePropagation` num
 * listener por componente decide por **ordem de registro**, e a ordem de
 * registro não é a ordem visual: o React roda efeito de filho antes do pai
 * (num `Modal` dentro de outro, quem registra por último é o de fora) e o
 * listener da tela pode ser anterior ao de um modal que abriu depois.
 *
 * A topologia do app faz com que "quem está por cima" seja a **ordem no
 * documento**: overlays são `position: fixed` com o mesmo z-index, então o
 * último a ser pintado é o último na árvore. Cada camada registra seu
 * elemento raíz, e o Esc vai para o último dela.
 */
const layers = [];
let listening = false;

// `el.compareDocumentPosition(outro)` tem o bit 2 (PRECEDING) quando `outro`
// vem antes de `el` — ou seja, `el` está mais abaixo na árvore/pintura.
function topLayer() {
  let top = null;
  for (const layer of layers) {
    const el = layer.getElement();
    if (!el || !el.isConnected) continue;
    if (!top) {
      top = layer;
      continue;
    }
    if (el.compareDocumentPosition(top.getElement()) & Node.DOCUMENT_POSITION_PRECEDING) {
      top = layer;
    }
  }
  return top;
}

function onKeyDown(e) {
  if (e.key !== "Escape" || e.repeat || e.defaultPrevented) return;
  const top = topLayer();
  if (!top) return;
  e.preventDefault();
  // Impede a tecla de vazar para os inputs do formulário e para listeners
  // globais de outras telas (o do login, por exemplo).
  e.stopImmediatePropagation();
  top.handler();
}

function push(layer) {
  layers.push(layer);
  if (!listening) {
    listening = true;
    window.addEventListener("keydown", onKeyDown, true);
  }
  return () => {
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    if (layers.length === 0) {
      window.removeEventListener("keydown", onKeyDown, true);
      listening = false;
    }
  };
}

/**
 * `Modal`, `ScreenHeader` e `ConfirmModal` registram o próprio descarte aqui no
 * mount. Captura (`true`) + guarda de `repeat`/`defaultPrevented` vivem na
 * pilha, e não em cada componente.
 */
export default function useEscapeLayer(onEscape) {
  const elementRef = useRef(null);
  useEffect(() => (onEscape ? push({ handler: onEscape, getElement: () => elementRef.current }) : undefined), [onEscape]);
  return elementRef;
}

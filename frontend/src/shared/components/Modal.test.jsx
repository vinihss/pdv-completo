import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal from "./Modal.jsx";
import ScreenHeader from "./ScreenHeader.jsx";
import ConfirmModal from "./ConfirmModal.jsx";

function setup(props = {}) {
  const onClose = vi.fn();
  const { unmount } = render(
    <Modal title="Pagamento" subtitle="R$ 37,00" onClose={onClose} {...props}>
      <p>corpo</p>
    </Modal>
  );
  return { onClose, unmount, dialog: screen.getByRole("dialog") };
}

// Desliza de `from` até `to` com um passo intermediário (o eixo do gesto só
// trava depois de AXIS_LOCK px de movimento).
function swipe(el, from, to) {
  fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: from }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: from + 20 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: to }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 0, clientY: to }] });
}

describe("Modal", () => {
  afterEach(cleanup);

  it("é um diálogo de tela cheia com título, subtítulo e X à direita", () => {
    const { dialog } = setup({ footer: <button>Registrar</button> });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.className).toContain("h-full");
    expect(screen.getByText("Pagamento")).toBeTruthy();
    expect(screen.getByText("R$ 37,00")).toBeTruthy();
    expect(screen.getByText("corpo")).toBeTruthy();
    expect(screen.getByText("Registrar")).toBeTruthy();
    expect(screen.getByLabelText("Fechar")).toBeTruthy();
  });

  it("X fecha", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByLabelText("Fechar"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape fecha", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape não fecha em repetição (segurar a tecla)", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("arrastar para baixo além do limiar fecha", () => {
    const { onClose, dialog } = setup();
    swipe(dialog, 0, 200);
    expect(onClose).toHaveBeenCalled();
  });

  it("arrastar para baixo curto volta sem fechar", () => {
    const { onClose, dialog } = setup();
    swipe(dialog, 0, 40);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("arrastar para cima não fecha", () => {
    const { onClose, dialog } = setup();
    swipe(dialog, 200, 0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("trava o scroll do fundo enquanto está aberto e devolve ao fechar", () => {
    const { unmount } = setup();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});

// A pilha de camadas (useEscapeLayer) resolve o que listener-por-componente
// não resolvia: `stopImmediatePropagation` decide por ordem de registro, não
// por camada — o header, montado antes, "vencia" do modal que estava por cima.
describe("pilha de camadas de Esc", () => {
  afterEach(cleanup);

  it("dois Modais aninhados: só o de cima fecha", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Modal title="Externo" onClose={outer}>
        <Modal title="Interno" onClose={inner}>
          <p>corpo</p>
        </Modal>
      </Modal>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("ConfirmModal sobre ScreenHeader: cancela a confirmação, não a tela", () => {
    const onBack = vi.fn();
    const onCancel = vi.fn();
    render(
      <>
        <ScreenHeader title="Comanda" onBack={onBack} />
        <ConfirmModal title="Remover item?" message="sai" confirmLabel="Remover" onCancel={onCancel} onConfirm={() => {}} />
      </>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("Modal sobre ConfirmModal: fecha o Modal (o topo), não a confirmação", () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    render(
      <>
        <ConfirmModal title="Remover item?" message="sai" confirmLabel="Remover" onCancel={onCancel} onConfirm={() => {}} />
        <Modal title="Pagamento" onClose={onClose}>
          <p>corpo</p>
        </Modal>
      </>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("camada desmontada não responde mais e a de baixo volta ao topo", () => {
    const onBack = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <>
        <ScreenHeader title="Comanda" onBack={onBack} />
        <ConfirmModal title="Remover item?" message="sai" confirmLabel="Remover" onCancel={onCancel} onConfirm={() => {}} />
      </>
    );
    rerender(<ScreenHeader title="Comanda" onBack={onBack} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Esc não vaza: um listener global da tela não roda junto", () => {
    const onClose = vi.fn();
    const tela = vi.fn();
    window.addEventListener("keydown", tela);
    render(<Modal title="Pagamento" onClose={onClose}><p>corpo</p></Modal>);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", tela);
    expect(onClose).toHaveBeenCalled();
    expect(tela).not.toHaveBeenCalled();
  });
});

import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Drawer from "./Drawer.jsx";
import ScreenHeader from "./ScreenHeader.jsx";

function setup(props = {}) {
  const onClose = vi.fn();
  const { unmount } = render(
    <Drawer open onClose={onClose} label="Menu principal" {...props}>
      <button>Comandas</button>
    </Drawer>
  );
  return { onClose, unmount, dialog: screen.getByRole("dialog") };
}

describe("Drawer", () => {
  afterEach(cleanup);

  it("é um diálogo modal com o rótulo informado", () => {
    const { dialog } = setup();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Menu principal");
    expect(screen.getByText("Comandas")).toBeTruthy();
  });

  it("entra pela esquerda por padrão e aceita a direita", () => {
    const { dialog, unmount } = setup();
    expect(dialog.className).toContain("left-0");
    expect(dialog.className).toContain("slide-in-left");
    unmount();
    const { dialog: right } = setup({ side: "right" });
    expect(right.className).toContain("right-0");
  });

  it("clicar no fundo fecha", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("dialog").previousSibling);
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

  it("trava o scroll do fundo enquanto está aberto e devolve ao fechar", () => {
    const { unmount } = setup();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("fechado não renderiza nada, não trava o scroll e não fica na pilha de Esc", () => {
    const onClose = vi.fn();
    render(
      <Drawer open={false} onClose={onClose}>
        <button>Comandas</button>
      </Drawer>
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("abre depois de fechado: o foco entra no painel na hora", () => {
    // jsdom não calcula layout, então offsetParent é sempre null e o filtro de
    // "elementos visíveis" do focus trap não acharia nada sem este stub.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", { get: () => document.body, configurable: true });
    try {
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();
      const { rerender } = render(
        <Drawer open={false} onClose={() => {}}>
          <button>Comandas</button>
        </Drawer>
      );
      rerender(
        <Drawer open onClose={() => {}}>
          <button>Comandas</button>
        </Drawer>
      );
      expect(document.activeElement).toBe(screen.getByText("Comandas"));
      document.body.removeChild(opener);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetParent", original);
      else delete HTMLElement.prototype.offsetParent;
    }
  });

  it("Esc vai para a camada de cima: o Drawer fecha, a tela de trás não", () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <>
        <ScreenHeader title="Comanda" onBack={onBack} />
        <Drawer open onClose={onClose} label="Menu principal">
          <button>Comandas</button>
        </Drawer>
      </>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("Esc não vaza: um listener global da tela não roda junto", () => {
    const onClose = vi.fn();
    const tela = vi.fn();
    window.addEventListener("keydown", tela);
    const { unmount } = setup({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    unmount();
    window.removeEventListener("keydown", tela);
    expect(onClose).toHaveBeenCalled();
    expect(tela).not.toHaveBeenCalled();
  });
});

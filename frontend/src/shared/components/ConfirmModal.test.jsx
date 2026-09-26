import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "./ConfirmModal.jsx";

function setup(props = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmModal
      title="Remover item?"
      message="2× Cerveja será removido da comanda."
      confirmLabel="Remover"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />
  );
  return { onCancel, onConfirm, dialog: screen.getByRole("alertdialog") };
}

describe("ConfirmModal", () => {
  afterEach(cleanup);

  it("é um card centralizado (não tela cheia) com aviso e ações", () => {
    const { dialog } = setup();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.className).not.toContain("h-full");
    expect(screen.getByText("Remover item?")).toBeTruthy();
    expect(screen.getByText("2× Cerveja será removido da comanda.")).toBeTruthy();
  });

  it("Cancelar e a confirmação disparam os handlers certos", () => {
    const { onCancel, onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalled();
  });

  it("Esc cancela", () => {
    const { onCancel, onConfirm } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Esc cancela em repetição (segurar a tecla)", () => {
    const { onCancel } = setup();
    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("destructive pinta a confirmação de vermelho", () => {
    setup({ destructive: true });
    const confirmButton = screen.getByRole("button", { name: "Remover" });
    expect(confirmButton.className).toContain("bg-red-500");
  });
});

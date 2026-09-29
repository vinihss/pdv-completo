import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import UserAvatar from "./UserAvatar.jsx";

const FOTO = "/uploads/u1.png";

function renderAvatar(props) {
  render(<UserAvatar name="Ana Ribeiro" {...props} />);
}

describe("UserAvatar", () => {
  afterEach(cleanup);

  it("com foto, desenha a imagem com o caminho público do backend", () => {
    renderAvatar({ photoPath: FOTO });
    expect(screen.getByAltText("Ana Ribeiro").getAttribute("src")).toBe(FOTO);
    // A imagem é o avatar inteiro: iniciais escondidas.
    expect(screen.queryByText("AR")).toBeNull();
  });

  it("sem foto, desenha as iniciais do primeiro e do segundo nome", () => {
    renderAvatar({});
    expect(screen.getByText("AR")).toBeTruthy();
    expect(screen.queryByAltText("Ana Ribeiro")).toBeNull();
  });

  it("nome de uma palavra só pega a inicial; nome vazio não quebra", () => {
    renderAvatar({ name: "Ana" });
    expect(screen.getByText("A")).toBeTruthy();
    cleanup();
    renderAvatar({ name: "" });
    expect(screen.getByText("?")).toBeTruthy();
  });

  it("foto quebrada cai para as iniciais em vez de deixar a imagem arrebentada", () => {
    renderAvatar({ photoPath: "/uploads/sumiu.png" });
    fireEvent.error(screen.getByAltText("Ana Ribeiro"));
    expect(screen.getByText("AR")).toBeTruthy();
    expect(screen.queryByAltText("Ana Ribeiro")).toBeNull();
  });

  it("o círculo, a cor e o tamanho são da casa e do caller", () => {
    renderAvatar({ className: "w-14 h-14 text-lg" });
    expect(screen.getByText("AR").className).toContain("rounded-full");
    expect(screen.getByText("AR").className).toContain("w-14 h-14");
    cleanup();
    renderAvatar({ photoPath: FOTO, className: "w-8 h-8" });
    expect(screen.getByAltText("Ana Ribeiro").className).toContain("w-8 h-8");
  });

  // Regressão: `mx-auto` (tela de PIN) só centraliza elemento de nível block, e
  // <img> é inline por padrão — sem `block` o avatar grudava na esquerda.
  it("a foto é block, senão o mx-auto do caller não centraliza", () => {
    renderAvatar({ photoPath: FOTO, className: "mx-auto" });
    expect(screen.getByAltText("Ana Ribeiro").className).toContain("block");
  });
});

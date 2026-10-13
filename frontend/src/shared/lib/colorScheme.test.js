import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyColorScheme,
  COLOR_SCHEME_STORAGE_KEY,
  getSavedColorScheme,
  initializeColorScheme,
  saveColorScheme,
} from "./colorScheme.js";

const themeColorMeta = () => document.querySelector('meta[name="theme-color"]');

describe("preferência de esquema de cores", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("usa claro por padrão e normaliza valores desconhecidos", () => {
    expect(getSavedColorScheme()).toBe("light");
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, "neon");
    expect(getSavedColorScheme()).toBe("light");
  });

  it("inicializa o tema salvo antes da renderização e atualiza o meta theme-color", () => {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, "dark");
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);

    expect(initializeColorScheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeColorMeta().content).toBe("#2d2925");

    meta.remove();
  });

  it("persiste a escolha e sincroniza o atributo de tema no documento", () => {
    expect(saveColorScheme("dark")).toBe("dark");
    expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    applyColorScheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

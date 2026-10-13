import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ThemeToggle from "./ThemeToggle.jsx";
import { COLOR_SCHEME_STORAGE_KEY, saveColorScheme } from "@/shared/lib/colorScheme.js";

afterEach(() => {
  cleanup();
  saveColorScheme("light");
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeToggle", () => {
  it("oferece ativar tema escuro e persiste a seleção ao alternar", () => {
    render(<ThemeToggle />);
    const toggle = screen.getByRole("button", { name: "Ativar tema escuro" });

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Ativar tema claro" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
  });
});

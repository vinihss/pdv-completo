import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import useNetworkStatus from "./useNetworkStatus.js";

function TestComponent() {
  const { isOnline } = useNetworkStatus();
  return <div>{isOnline ? "Online" : "Offline"}</div>;
}

describe("useNetworkStatus", () => {
  beforeEach(() => {
    // Simula estado online por padrão
    Object.defineProperty(navigator, "onLine", {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retorna isOnline=true quando navegador está online", () => {
    render(<TestComponent />);
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("atualiza para offline quando evento 'offline' é disparado", () => {
    render(<TestComponent />);
    expect(screen.getByText("Online")).toBeTruthy();

    fireEvent(window, new Event("offline"));
    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it("volta para online quando evento 'online' é disparado", () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      writable: true,
      configurable: true,
    });
    render(<TestComponent />);
    expect(screen.getByText("Offline")).toBeTruthy();

    fireEvent(window, new Event("online"));
    expect(screen.getByText("Online")).toBeTruthy();
  });
});

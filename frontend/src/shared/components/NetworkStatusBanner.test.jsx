import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import NetworkStatusBanner from "./NetworkStatusBanner.jsx";

// Mock do hook usando vi.hoisted para evitar erro de inicialização
const mockUseNetworkStatus = vi.hoisted(() => vi.fn());
vi.mock("@/shared/hooks", () => ({
  useNetworkStatus: mockUseNetworkStatus,
}));

describe("NetworkStatusBanner", () => {
  beforeEach(() => {
    mockUseNetworkStatus.mockReset();
  });

  it("não renderiza quando está online", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: true });
    const { container } = render(<NetworkStatusBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renderiza banner quando está offline", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: false });
    render(<NetworkStatusBanner />);
    
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Sem conexão com a internet")).toBeTruthy();
  });

  it("banner tem aria-live assertive para acessibilidade", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: false });
    render(<NetworkStatusBanner />);
    
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("aria-live")).toBe("assertive");
  });
});

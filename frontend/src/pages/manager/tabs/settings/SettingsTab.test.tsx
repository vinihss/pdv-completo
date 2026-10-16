import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsTab from "./SettingsTab.jsx";

const mocks = vi.hoisted(() => ({
  storeSettings: {
    merchantName: "Café Teste",
    merchantCity: "Curitiba",
    brandColor: "#b7791f",
    logoUrl: "",
    enabledPaymentMethods: ["cash"],
    usesTables: true,
    kitchenEnabled: false,
    ifoodIntegrationEnabled: false,
    whatsappIntegrationEnabled: false,
    inventoryEnabled: false,
    purchaseEnabled: false,
    printerEnabled: false,
    usesDelivery: false,
    deliveryFee: 0,
    deliveryFeeTiers: [],
    deliveryPrepMinutes: 30,
    minutesPerKm: 2,
    freeDeliveryMin: 0,
  },
  refreshStoreSettings: vi.fn(),
}));

vi.mock("@/app/providers/auth", () => ({
  useAuth: () => ({
    storeSettings: mocks.storeSettings,
    refreshStoreSettings: mocks.refreshStoreSettings,
  }),
}));

vi.mock("@/entities/store", () => ({
  updateStoreSettings: vi.fn(),
  uploadStoreLogo: vi.fn(),
  removeStoreLogo: vi.fn(),
}));

afterEach(cleanup);

describe("SettingsTab", () => {
  it("organiza configurações em subabas e mostra somente a seção selecionada", async () => {
    const { container } = render(<SettingsTab showToast={() => {}} />);
    const identityTab = await screen.findByRole("tab", { name: "Identidade" });
    const operationTab = screen.getByRole("tab", { name: "Operação" });
    const operationSection = screen.getByText("Modo de operação", { selector: ".text-text-muted" });

    expect(screen.getByRole("heading", { name: "Configurações" })).toBeTruthy();
    expect(identityTab.getAttribute("aria-selected")).toBe("true");
    expect(operationSection.closest("[hidden]")).toBeTruthy();
    expect(container.querySelector(".max-w-lg")).toBeNull();

    fireEvent.click(operationTab);

    expect(operationTab.getAttribute("aria-selected")).toBe("true");
    expect(operationSection.closest("[hidden]")).toBeNull();
  });
});

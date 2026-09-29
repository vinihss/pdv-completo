import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AppConfigProvider } from "@/app/providers/app-config";
import { BootGate } from "./BootGate.jsx";

// O BootGate é a primeira coisa que o gerente vê no terminal. O teste trava
// as duas metades: no web ele some (zero regressão no PWA atual) e no desktop
// ele segura a abertura até confirmar que há sistema — com aviso certo para
// plano nuvem e para plano local.

const mocks = vi.hoisted(() => ({
  loadAppConfig: vi.fn(),
  persistAppConfig: vi.fn(async (config) => config),
  clearAppConfig: vi.fn(),
  pingApi: vi.fn(async () => true),
  checkForUpdate: vi.fn(async () => ({ available: false })),
  installUpdate: vi.fn(),
  relaunch: vi.fn(async () => true),
}));

vi.mock("@/app/providers/app-config/api.js", () => ({
  loadAppConfig: () => mocks.loadAppConfig(),
  persistAppConfig: (config) => mocks.persistAppConfig(config),
  clearAppConfig: () => mocks.clearAppConfig(),
}));

vi.mock("@/shared/api/http.js", () => ({
  request: vi.fn(),
  upload: vi.fn(),
  pingApi: (...args) => mocks.pingApi(...args),
}));

vi.mock("@/entities/updater", () => ({
  checkForUpdate: (...args) => mocks.checkForUpdate(...args),
  installUpdate: (...args) => mocks.installUpdate(...args),
  relaunch: (...args) => mocks.relaunch(...args),
  UPDATE_CHECK_TIMEOUT_MS: 3000,
}));

const children = <p>app carregado</p>;

// No app real quem monta o provider é App.jsx; aqui o mesmo par.
function renderGate() {
  return render(
    <AppConfigProvider>
      <BootGate>{children}</BootGate>
    </AppConfigProvider>,
  );
}

function asDesktop() {
  window.__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  delete window.__TAURI_INTERNALS__;
  mocks.loadAppConfig.mockReset().mockResolvedValue(null);
  mocks.pingApi.mockReset().mockResolvedValue(true);
  mocks.checkForUpdate.mockReset().mockResolvedValue({ available: false });
});

describe("BootGate no web", () => {
  it("deixa o app passar direto, sem checar nada", async () => {
    mocks.loadAppConfig.mockResolvedValue(null);
    renderGate();

    expect(screen.getByText("app carregado")).toBeTruthy();
    expect(mocks.pingApi).not.toHaveBeenCalled();
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });
});

describe("BootGate no desktop", () => {
  beforeEach(() => {
    asDesktop();
  });

  it("sem config: pede a configuração em vez de tentar abrir", async () => {
    mocks.loadAppConfig.mockResolvedValue(null);
    renderGate();

    await waitFor(() => expect(screen.getByText("Configurar este computador")).toBeTruthy());
    expect(mocks.pingApi).not.toHaveBeenCalled();
  });

  it("sistema no ar: abre o app", async () => {
    mocks.loadAppConfig.mockResolvedValue({ mode: "cloud", apiBase: "https://app.exemplo.com.br" });
    renderGate();

    await waitFor(() => expect(screen.getByText("app carregado")).toBeTruthy());
    expect(mocks.pingApi).toHaveBeenCalledTimes(1);
  });

  it("plano nuvem sem resposta: aviso de internet, com o endereço e botão de tentar de novo", async () => {
    mocks.loadAppConfig.mockResolvedValue({ mode: "cloud", apiBase: "https://app.exemplo.com.br" });
    mocks.pingApi.mockResolvedValue(false);
    renderGate();

    await waitFor(() => expect(screen.getByText("Sem conexão com o sistema")).toBeTruthy());
    expect(screen.getByText("https://app.exemplo.com.br")).toBeTruthy();

    // "Tentar de novo" volta a checar e agora o sistema responde.
    mocks.pingApi.mockResolvedValue(true);
    screen.getByRole("button", { name: /tentar de novo/i }).click();
    await waitFor(() => expect(screen.getByText("app carregado")).toBeTruthy());
    expect(mocks.pingApi).toHaveBeenCalledTimes(2);
  });

  it("plano local sem resposta: aviso de sistema parado (não de internet)", async () => {
    mocks.loadAppConfig.mockResolvedValue({ mode: "local", apiBase: "http://127.0.0.1:3000" });
    mocks.pingApi.mockResolvedValue(false);
    renderGate();

    await waitFor(() => expect(screen.getByText("O sistema local não está rodando")).toBeTruthy());
    // no plano local o update é opcional e não bloqueia
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("update disponível mostra a barra de progresso e só então reabre", async () => {
    mocks.loadAppConfig.mockResolvedValue({ mode: "cloud", apiBase: "https://app.exemplo.com.br" });
    mocks.checkForUpdate.mockResolvedValue({
      available: true,
      version: "0.3.0",
      notes: "",
      update: {},
    });
    let release;
    mocks.installUpdate.mockImplementation(
      (_update, onProgress) =>
        new Promise((resolve) => {
          release = () => {
            onProgress({ downloaded: 5, total: 10, percent: 50 });
            resolve({ ok: true });
          };
        }),
    );

    renderGate();

    await waitFor(() => expect(screen.getByText("Atualizando o aplicativo")).toBeTruthy());
    expect(screen.getByText("Nova versão 0.3.0")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();

    release();
    await waitFor(() => expect(screen.getByText("Atualização concluída")).toBeTruthy());
    expect(mocks.relaunch).toHaveBeenCalled();
  });

  it("update que falha abre a versão atual em vez de travar", async () => {
    mocks.loadAppConfig.mockResolvedValue({ mode: "cloud", apiBase: "https://app.exemplo.com.br" });
    mocks.checkForUpdate.mockResolvedValue({ available: true, version: "0.3.0", notes: "", update: {} });
    mocks.installUpdate.mockResolvedValue({ ok: false, reason: "sem espaço em disco" });

    renderGate();

    await waitFor(() => expect(screen.getByText("app carregado")).toBeTruthy());
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});

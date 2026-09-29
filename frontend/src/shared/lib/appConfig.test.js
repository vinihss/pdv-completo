import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_DAEMON_URL,
  apiBase,
  daemonBase,
  isApiConfigured,
  normalizeConfig,
  normalizeOrigin,
  setAppConfig,
  wsEndpoint,
} from "./appConfig.js";
import { isDesktop, isWeb } from "./platform.js";

// A config do aplicativo decide de onde vem a API. São três situacões
// distintas e o comportamento do web não pode mudar (lá a API é sempre a
// mesma origem que serve a página — Caddy/nginx).

beforeEach(() => {
  setAppConfig(null);
  delete window.__TAURI_INTERNALS__;
});

describe("normalizeOrigin", () => {
  it("completa o esquema https quando o gestor digita só o domínio", () => {
    expect(normalizeOrigin("app.exemplo.com.br")).toBe("https://app.exemplo.com.br");
  });

  it("mantém http em rede local (https em IP privado quebra mais do que acerta)", () => {
    expect(normalizeOrigin("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeOrigin("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("192.168.0.10:3000")).toBe("http://192.168.0.10:3000");
  });

  it("respeita o esquema informado", () => {
    expect(normalizeOrigin("http://app.exemplo.com.br")).toBe("http://app.exemplo.com.br");
  });

  it("tira barra final e espaços", () => {
    expect(normalizeOrigin("  https://app.exemplo.com.br/  ")).toBe("https://app.exemplo.com.br");
  });

  it("devolve vazio para entrada inútil", () => {
    expect(normalizeOrigin("")).toBe("");
    expect(normalizeOrigin(undefined)).toBe("");
    expect(normalizeOrigin("não é url")).toBe("");
  });
});

describe("normalizeConfig", () => {
  it("preenche modo e daemon, e normaliza a origem", () => {
    expect(normalizeConfig({ mode: "cloud", apiBase: "app.exemplo.com.br/", daemonUrl: "" })).toEqual({
      mode: "cloud",
      apiBase: "https://app.exemplo.com.br",
      daemonUrl: DEFAULT_DAEMON_URL,
    });
  });

  it("modo desconhecido cai em local (padrão do plano local)", () => {
    expect(normalizeConfig({ mode: "banana" }).mode).toBe("local");
    expect(normalizeConfig(null).mode).toBe("local");
  });
});

describe("apiBase", () => {
  it("no web (sem config) continua relativa — mesmo comportamento de sempre", () => {
    expect(isApiConfigured()).toBe(false);
    expect(apiBase()).toBe("/api");
  });

  it("no desktop usa a origem configurada", () => {
    setAppConfig({ mode: "cloud", apiBase: "app.exemplo.com.br", daemonUrl: "" });
    expect(isApiConfigured()).toBe(true);
    expect(apiBase()).toBe("https://app.exemplo.com.br/api");
  });

  it("backend local na própria máquina", () => {
    setAppConfig({ mode: "local", apiBase: "http://127.0.0.1:3000", daemonUrl: "" });
    expect(apiBase()).toBe("http://127.0.0.1:3000/api");
  });
});

describe("wsEndpoint", () => {
  it("no web cai no host atual (preserva o comportamento do useRealtime)", () => {
    expect(wsEndpoint("/realtime")).toBe(`ws://${window.location.host}/realtime`);
  });

  it("no desktop deriva da origem configurada, com wss em https", () => {
    setAppConfig({ mode: "cloud", apiBase: "https://app.exemplo.com.br", daemonUrl: "" });
    expect(wsEndpoint("/realtime")).toBe("wss://app.exemplo.com.br/realtime");
    expect(wsEndpoint("/realtime/public")).toBe("wss://app.exemplo.com.br/realtime/public");
  });

  it("backend local em http continua ws:", () => {
    setAppConfig({ mode: "local", apiBase: "http://127.0.0.1:3000", daemonUrl: "" });
    expect(wsEndpoint("/realtime")).toBe("ws://127.0.0.1:3000/realtime");
  });

  it("preserva um base path e normaliza barras", () => {
    setAppConfig({ mode: "cloud", apiBase: "https://exemplo.com/pdv/", daemonUrl: "" });
    expect(wsEndpoint("/realtime")).toBe("wss://exemplo.com/pdv/realtime");
  });
});

describe("daemonBase", () => {
  it("padrão é o loopback que o backend espera", () => {
    expect(daemonBase()).toBe(DEFAULT_DAEMON_URL);
  });

  it("usa a porta customizada quando configurada", () => {
    setAppConfig({ mode: "local", apiBase: "", daemonUrl: "http://127.0.0.1:9090" });
    expect(daemonBase()).toBe("http://127.0.0.1:9090");
  });
});

describe("isDesktop", () => {
  it("webview do Tauri é detectado por __TAURI_INTERNALS__", () => {
    expect(isDesktop()).toBe(false);
    expect(isWeb()).toBe(true);
    window.__TAURI_INTERNALS__ = {};
    expect(isDesktop()).toBe(true);
    expect(isWeb()).toBe(false);
  });
});

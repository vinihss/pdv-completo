// Portado de frontend/src/shared/lib/appConfig.test.js. Diferenças RN:
// não existe `window`/`window.location` — sem config, `wsEndpoint` devolve só
// o path (o useRealtime/teste cobre o guard) e o caso "isDesktop" sumiu.
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

// A config do aplicativo decide de onde vem a API: no mobile nunca há "mesma
// origem" (não existe host da página) — ou há config persistida, ou a tela de
// setup bloqueia o app.

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
  it("sem config continua relativa — mesmo valor do web, mas ninguém chama sem passar pela setup", () => {
    expect(isApiConfigured()).toBe(false);
    expect(apiBase()).toBe("/api");
  });

  it("com servidor configurado usa a origem + /api", () => {
    setAppConfig({ mode: "cloud", apiBase: "app.exemplo.com.br", daemonUrl: "" });
    expect(isApiConfigured()).toBe(true);
    expect(apiBase()).toBe("https://app.exemplo.com.br/api");
  });

  it("backend local na rede da loja", () => {
    setAppConfig({ mode: "local", apiBase: "http://192.168.0.10:3000", daemonUrl: "" });
    expect(apiBase()).toBe("http://192.168.0.10:3000/api");
  });
});

describe("wsEndpoint", () => {
  it("deriva da origem configurada, com wss em https", () => {
    setAppConfig({ mode: "cloud", apiBase: "https://app.exemplo.com.br", daemonUrl: "" });
    expect(wsEndpoint("/realtime")).toBe("wss://app.exemplo.com.br/realtime");
    expect(wsEndpoint("/realtime/public")).toBe("wss://app.exemplo.com.br/realtime/public");
  });

  it("backend local em http continua ws:", () => {
    setAppConfig({ mode: "local", apiBase: "http://192.168.0.10:3000", daemonUrl: "" });
    expect(wsEndpoint("/realtime")).toBe("ws://192.168.0.10:3000/realtime");
  });

  it("preserva um base path e normaliza barras", () => {
    setAppConfig({ mode: "cloud", apiBase: "https://exemplo.com/pdv/", daemonUrl: "" });
    expect(wsEndpoint("/realtime")).toBe("wss://exemplo.com/pdv/realtime");
  });

  it("sem configuração devolve o path puro (o app não chega aqui sem setup)", () => {
    setAppConfig(null);
    expect(wsEndpoint("/realtime")).toBe("/realtime");
  });
});

describe("daemonBase", () => {
  it("padrão é o loopback que o backend espera", () => {
    setAppConfig(null);
    expect(daemonBase()).toBe(DEFAULT_DAEMON_URL);
  });

  it("usa a URL configurada quando presente", () => {
    setAppConfig({ mode: "local", apiBase: "", daemonUrl: "http://192.168.0.10:8080" });
    expect(daemonBase()).toBe("http://192.168.0.10:8080");
  });
});
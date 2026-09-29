import { beforeEach, describe, expect, it } from "vitest";
import {
  apiUrl,
  assetUrl,
  currentServerLabel,
  getServerBase,
  setServerBase,
  validateServerUrl,
  wsUrl,
} from "./server";

const KEY = "pdv:server";

describe("server base", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("sem servidor configurado (navegador)", () => {
    it("apiUrl continua relativa — é o que o PWA espera", () => {
      expect(apiUrl("/auth/login")).toBe("/api/auth/login");
    });

    it("assetUrl devolve o caminho intacto", () => {
      expect(assetUrl("/uploads/logo.png")).toBe("/uploads/logo.png");
    });

    it("wsUrl usa a origem da própria página", () => {
      const { protocol, host } = window.location;
      const expected = `${protocol === "https:" ? "wss:" : "ws:"}//${host}/realtime`;
      expect(wsUrl()).toBe(expected);
    });

    it("currentServerLabel mostra a origem da página", () => {
      expect(currentServerLabel()).toBe(window.location.origin);
    });
  });

  describe("com servidor configurado (app desktop)", () => {
    beforeEach(() => {
      setServerBase("https://app.umamisushiarte.com.br");
    });

    it("guarda a base e usa nas três URLs", () => {
      expect(getServerBase()).toBe("https://app.umamisushiarte.com.br");
      expect(apiUrl("/orders")).toBe("https://app.umamisushiarte.com.br/api/orders");
      expect(assetUrl("/uploads/x.png")).toBe("https://app.umamisushiarte.com.br/uploads/x.png");
      expect(wsUrl()).toBe("wss://app.umamisushiarte.com.br/realtime");
    });

    it("não duplica barra quando o valor salvo tem barra no fim", () => {
      setServerBase("https://app.umamisushiarte.com.br/");
      expect(apiUrl("/orders")).toBe("https://app.umamisushiarte.com.br/api/orders");
    });

    it("aceita servidor http e deriva ws://", () => {
      setServerBase("http://192.168.0.10:3000");
      expect(wsUrl()).toBe("ws://192.168.0.10:3000/realtime");
      expect(apiUrl("/health")).toBe("http://192.168.0.10:3000/api/health");
    });
  });

  describe("assetUrl", () => {
    it("não mexe em URL absoluta, data: nem blob:", () => {
      expect(assetUrl("https://cdn.exemplo.com/a.png")).toBe("https://cdn.exemplo.com/a.png");
      expect(assetUrl("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
      expect(assetUrl("blob:http://localhost/abc")).toBe("blob:http://localhost/abc");
    });

    it("propaga null/vazio sem virar 'null'", () => {
      expect(assetUrl(null)).toBe(null);
      expect(assetUrl("")).toBe("");
    });
  });

  describe("validateServerUrl", () => {
    it("aceita vazio (mesma origem) e normaliza barra final", () => {
      expect(validateServerUrl("")).toEqual({ ok: true, value: "" });
      expect(validateServerUrl("https://a.com.br/")).toEqual({ ok: true, value: "https://a.com.br" });
    });

    it("preserva subpath (app publicado com prefixo)", () => {
      expect(validateServerUrl("https://a.com.br/pdv/")).toEqual({
        ok: true,
        value: "https://a.com.br/pdv",
      });
    });

    it("rejeita esquema que não é http(s)", () => {
      const r = validateServerUrl("ftp://a.com");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/http/);
    });

    it("rejeita lixo", () => {
      expect(validateServerUrl("   ").ok).toBe(true); // vazio = mesma origem
      expect(validateServerUrl("http://").ok).toBe(false);
    });
  });

  describe("setServerBase", () => {
    it("não grava valor inválido", () => {
      const r = setServerBase("nao-e-url");
      expect(r.ok).toBe(false);
      expect(localStorage.getItem(KEY)).toBe(null);
    });

    it("grava normalizado e limpa com vazio", () => {
      setServerBase("https://a.com.br/");
      expect(localStorage.getItem(KEY)).toBe("https://a.com.br");
      setServerBase("");
      expect(localStorage.getItem(KEY)).toBe("");
      expect(getServerBase()).toBe("");
    });
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { api, closeTestApp } from "./helpers.js";

// O Caddy pergunta `GET /internal/caddy-on-demand-tls?domain=<host>` antes de
// emitir (ou servir do storage) um certificado on-demand; 2xx libera, demais
// bloqueia a emissão. A regra é "UMA label": libera `foo.labolabe.tech` e
// `foo.<raiz da plataforma>` (app/api/www e os tenants do wildcard), e recusa
// o apex (`<raiz>`), rótulos múltiplos (`foo.bar.<raiz>`) e domínios fora.

const URL_ = "/internal/caddy-on-demand-tls";

async function ask(domain: string): Promise<number> {
  const res = await api("get", `${URL_}?domain=${encodeURIComponent(domain)}`);
  return res.status;
}

afterAll(async () => {
  await closeTestApp();
});

describe("ask do TLS on-demand (GET /internal/caddy-on-demand-tls)", () => {
  it("libera uma label de labolabe.tech", async () => {
    expect(await ask("foo.labolabe.tech")).toBe(204);
    expect(await ask("app.labolabe.tech")).toBe(204);
  });

  it("libera uma label do domínio raiz da plataforma", async () => {
    expect(await ask("app.umamisushiarte.com.br")).toBe(204);
    expect(await ask("api.umamisushiarte.com.br")).toBe(204);
    expect(await ask("www.umamisushiarte.com.br")).toBe(204);
    expect(await ask("pdv1.umamisushiarte.com.br")).toBe(204);
  });

  it("recusa o apex da raiz (managed de propósito)", async () => {
    expect(await ask("umamisushiarte.com.br")).toBe(403);
    expect(await ask("labolabe.tech")).toBe(403);
  });

  it("recusa múltiplas labels do domínio raiz", async () => {
    expect(await ask("foo.bar.umamisushiarte.com.br")).toBe(403);
    expect(await ask("a.b.c.labolabe.tech")).toBe(403);
  });

  it("recusa domínio aleatório e host vazio", async () => {
    expect(await ask("evil.example.com")).toBe(403);
    expect(await ask("umamisushiarte.com.br.evil.com")).toBe(403);
    expect(await ask("")).toBe(403);
  });

  it("normaliza para minúsculas antes de casar", async () => {
    expect(await ask("App.UmamiSushiArte.com.br")).toBe(204);
    expect(await ask("FOO.LABOLABE.TECH")).toBe(204);
    expect(await ask("UMAMISUSHIARTE.COM.BR")).toBe(403);
  });

  it("respeita PLATFORM_ROOT_DOMAIN quando definida", async () => {
    const previous = process.env.PLATFORM_ROOT_DOMAIN;
    process.env.PLATFORM_ROOT_DOMAIN = "OutroDominio.Com.BR";
    try {
      expect(await ask("app.outrodominio.com.br")).toBe(204);
      expect(await ask("app.umamisushiarte.com.br")).toBe(403);
      // Ponto é metacaracter de regex: `outrodominioXcomBr` não pode passar.
      expect(await ask("app.outrodominioXcomBr")).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_ROOT_DOMAIN;
      else process.env.PLATFORM_ROOT_DOMAIN = previous;
    }
  });
});

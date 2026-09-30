import { describe, it, expect, afterAll } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL,
  APP_PROFILE_IDS,
  appProfilePlugin,
  isAppProfile,
  resolveAppProfile,
} from "./app-profiles.js";

// Raiz real do frontend: o plugin lê `public/manifest.json` e `public/sw.js`
// de verdade, então o teste pega alguém editando esses arquivos sem saber que
// o build depende deles.
const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

/**
 * Roda o plugin inteiro (configResolved + hooks) contra um outDir de
 * mentira, já com os arquivos de `public/` copiados para dentro — é o que o
 * Vite faz no começo do build (dentro do `buildStart`), e é o que torna
 * observável a decisão do plugin de não escrever nada no profile `all`.
 */
async function runPlugin(profile) {
  const outDir = mkdtempSync(join(tmpdir(), "pdv-app-profile-"));
  for (const name of ["manifest.json", "sw.js"]) {
    copyFileSync(join(ROOT, "public", name), join(outDir, name));
  }
  const plugin = appProfilePlugin({ appProfile: profile });
  plugin.configResolved({ root: ROOT, build: { outDir } });
  await plugin.closeBundle();
  const read = (name) => readFileSync(join(outDir, name), "utf8");
  return {
    outDir,
    manifest: read("manifest.json"),
    sw: read("sw.js"),
    cleanup: () => rmSync(outDir, { recursive: true, force: true }),
  };
}

describe("VITE_APP_PROFILE", () => {
  it("conhece os 5 profiles e só eles", () => {
    expect(APP_PROFILE_IDS).toEqual(["all", "pdv", "kds", "garcon", "entregador"]);
  });

  it("valor desconhecido, vazio ou herdado do prototype vira o app único", () => {
    // `__proto__`/`constructor` passariam num `in` ingênuo e dariam um profile
    // que não existe — daí o Object.hasOwn em isAppProfile.
    for (const raw of [undefined, "", "  ", "caixa", "TOUpperCase", "__proto__", "constructor"]) {
      expect(resolveAppProfile(raw)).toBe(ALL);
      expect(isAppProfile(raw)).toBe(false);
    }
  });

  it("aceita os profiles válidos, ignorando espaço em volta", () => {
    for (const id of APP_PROFILE_IDS) {
      expect(resolveAppProfile(id)).toBe(id);
      expect(resolveAppProfile(` ${id} `)).toBe(id);
      expect(isAppProfile(id)).toBe(true);
    }
  });
});

describe("profile injetado na entry", () => {
  const entry = (profile) =>
    `<html><head><title>velho</title>
     <meta name="app-profile" content="${profile}" />
     <script data-app-profile>window.__APP_PROFILE__ = "velho";</script>
     <meta name="apple-mobile-web-app-title" content="velho" />
     </head><body></body></html>`;

  it("no app único é a própria entry que diz qual é", () => {
    const plugin = appProfilePlugin({ appProfile: ALL });
    // O index.html do build padrão declara `all`: ele é o app inteiro, o que
    // `frontendDist: "../dist"` abre. Se virasse `pdv`, o app de produção
    // passaria a se chamar "Caixa" na janela e no menu do sistema.
    expect(plugin.transformIndexHtml(entry("all"))).toContain('window.__APP_PROFILE__ = "all"');
    for (const id of ["kds", "garcon", "entregador"]) {
      const out = plugin.transformIndexHtml(entry(id));
      expect(out).toContain(`window.__APP_PROFILE__ = "${id}"`);
      expect(out).toContain(`content="${id}"`);
    }
  });

  it("no app isolado quem manda é o build, não a entry", () => {
    // A entry de um app isolado é sempre o index.html, que declara `all`.
    const out = appProfilePlugin({ appProfile: "kds" }).transformIndexHtml(entry("all"));
    expect(out).toContain('window.__APP_PROFILE__ = "kds"');
    expect(out).toContain('content="kds"');
    expect(out).not.toContain('"all"');
  });

  it("reescreve o título e o nome do app na tela de início", () => {
    const out = appProfilePlugin({ appProfile: "entregador" }).transformIndexHtml(entry("all"));
    expect(out).toContain("<title>Entregador</title>");
    expect(out).toContain('apple-mobile-web-app-title" content="Entregador"');
  });
});

describe("PWA por profile", () => {
  const tmp = [];
  afterAll(() => tmp.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const run = async (profile) => {
    const result = await runPlugin(profile);
    tmp.push(result.outDir);
    return result;
  };

  it("o build padrão não mexe em nada — é o app que já está em produção", async () => {
    const { manifest, sw } = await run(ALL);
    expect(manifest).toBe(readFileSync(join(ROOT, "public/manifest.json"), "utf8"));
    // O `STATIC_CACHE` sai como literal em vez de template, mas o valor
    // precisa ser exatamente o de sempre.
    expect(sw).toContain('const STATIC_CACHE = "pdv-static-v1";');
    expect(JSON.parse(manifest)).toMatchObject({ name: "PDV", short_name: "PDV" });
  });

  it("cada app tem nome próprio e escopo na raiz do seu diretório", async () => {
    for (const [id, nome] of [
      ["pdv", "PDV — Caixa"],
      ["kds", "PDV — Cozinha"],
      ["garcon", "PDV — Garçom"],
      ["entregador", "PDV — Entregador"],
    ]) {
      const parsed = JSON.parse((await run(id)).manifest);
      expect(parsed.name).toBe(nome);
      // `./` e não `/kds/`: o Tauri serve o `frontendDist` na raiz da origem
      // (tauri://localhost), onde `/kds/` seria 404.
      expect(parsed.start_url).toBe("./");
      expect(parsed.scope).toBe("./");
      expect(parsed.icons).toEqual(JSON.parse(readFileSync(join(ROOT, "public/manifest.json"), "utf8")).icons);
    }
  });

  it("cada app tem cache próprio e os prefixos não se cruzam", async () => {
    const seen = [];
    for (const id of APP_PROFILE_IDS) {
      const { sw } = await run(id);
      const prefix = sw.match(/const CACHE_PREFIX = "([^"]*)";/)[1];
      const cache = sw.match(/const STATIC_CACHE = "([^"]*)";/)[1];
      expect(cache.startsWith(prefix)).toBe(true);
      // Nenhum prefixo pode ser prefixo de outro: o `activate` apaga tudo que
      // começa com o dele, e um app apagaria o cache dos outros na mesma
      // origem.
      for (const other of seen) {
        expect(other.startsWith(prefix) || prefix.startsWith(other)).toBe(false);
      }
      seen.push(prefix);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("a regra que não pode sumir: /api e /realtime nunca entram no cache", async () => {
    for (const id of APP_PROFILE_IDS) {
      const { sw } = await run(id);
      expect(sw).toContain('url.pathname.startsWith("/api") || url.pathname.startsWith("/realtime")');
    }
  });
});

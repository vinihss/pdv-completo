/**
 * Um build, quatro apps.
 *
 * O MESMO bundle React sobe nas 4 entries (`index.html` = frente de caixa,
 * `kds.html` = cozinha) — nada de app
 * duplicado. O que precisa variar por app é só o que o navegador guarda por
 * instalação:
 *
 *   - `name`/`short_name` do manifest: 4 PWAs com o mesmo nome viram 4 cópias
 *     indistinguíveis no menu do sistema.
 *   - o cache do service worker: `caches` é por origem, então 4 apps com o
 *     mesmo cache name dividem o mesmo `CacheStorage` — um sobrescreve o outro
 *     e o `activate` de um apaga o cache dos demais.
 *
 * `all` (default) é o app único que já está em produção — `frontendDist:
 * "../dist"` em `src-tauri/tauri.conf.json` aponta para a raiz de `dist/`.
 * Nesse profile o plugin não escreve nada: os arquivos de `public/` já são
 * exatamente o que o app instalado precisa, byte a byte.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** App único: as 4 entries lado a lado em `dist/`. É o default. */
export const ALL = "all";

/**
 * Texto que aparece para o usuário + título da janela. `description` só é
 * usada no manifest.
 *
 * `all` repete o que já estava em `public/manifest.json` — o app de produção
 * não pode trocar de nome no menu instalado.
 *
 * `cachePrefix` é a família de caches do app: o `activate` do `public/sw.js`
 * apaga todo cache que começa com esse prefixo e não seja o atual. Por isso
 * o prefixo é exclusivo de cada app (`pdv-static-kds-v` nunca casa com o
 * `pdv-static-v1` do app único) — se fosse compartilhado, instalar os 4 no
 * mesmo host apagaria o cache do outro assim que o service worker assumisse.
 */
const APP_PROFILES = {
  all: {
    name: "PDV",
    shortName: "PDV",
    title: "PDV",
    description: "Comandas, cozinha e gestão — PDV",
    cachePrefix: "pdv-static-v",
  },
  pdv: {
    name: "PDV — Caixa",
    shortName: "Caixa",
    title: "Caixa",
    description: "Comandas e caixa",
    cachePrefix: "pdv-static-pdv-v",
  },
  kds: {
    name: "PDV — Cozinha",
    shortName: "Cozinha",
    title: "Cozinha",
    description: "Tela de produção da cozinha",
    cachePrefix: "pdv-static-kds-v",
  },

};

/** Os profiles aceitos em `VITE_APP_PROFILE` (o `all` inclusive). */
export const APP_PROFILE_IDS = Object.keys(APP_PROFILES);

/**
 * `Object.hasOwn` (e não `in`) para o valor do env não virar acesso a
 * `__proto__`/`constructor` e acabar num profile que não existe.
 */
export function isAppProfile(value) {
  return typeof value === "string" && Object.hasOwn(APP_PROFILES, value);
}

/** Valor do env já validado. Qualquer coisa fora da lista vira `all`. */
export function resolveAppProfile(raw) {
  const value = String(raw ?? "").trim();
  return isAppProfile(value) ? value : ALL;
}

/** Geração viva do cache: prefixo da família + índice. */
function staticCacheOf(meta) {
  return `${meta.cachePrefix}2`;
}

/** O `<script data-app-profile>` de cada entry — lugar do valor do runtime. */
const ENTRY_SCRIPT_RE = /<script\s+data-app-profile\s*>[\s\S]*?<\/script>/;

/** `<meta name="app-profile" content="...">` — o que a entry declara. */
const ENTRY_META_RE = /(<meta\s+name="app-profile"\s+content=")([^"]*)(")/;

/**
 * Profile declarado pela entry. No build `all` é isto que diz se o HTML
 * carregado é o da cozinha ou o do garçom (e se o index.html é o app inteiro
 * — que é o que `frontendDist: "../dist"` abre). Num build de app único quem
 * manda é o `VITE_APP_PROFILE`, porque a entry é sempre o `index.html`, que
 * declara `all` e mentiria.
 */
function readEntryProfile(html) {
  // Grupo 2 é o valor (o 1 é o prefixo da tag e o 3 é a aspa de fechamento).
  const found = html.match(ENTRY_META_RE);
  const value = found?.[2]?.trim();
  return isAppProfile(value) ? value : null;
}

/**
 * `public/sw.js` tem que continuar com essas duas consts — são o ponto de
 * troca do build. Se alguém renomear, o build para em vez de silenciosamente
 * voltar a compartilhar um cache só entre os 4 apps. Os dois padrões aceitam
 * string ou template literal, porque no `public/` o `STATIC_CACHE` é escrito
 * como template de `CACHE_PREFIX` para deixar claro de onde vem o nome.
 */
const SW_CACHE_PREFIX_RE = /const CACHE_PREFIX = (?:"[^"]*"|`[^`]*`);/;
const SW_STATIC_CACHE_RE = /const STATIC_CACHE = (?:"[^"]*"|`[^`]*`);/;

function patchStaticCache(source, profile) {
  const meta = APP_PROFILES[profile];
  if (!SW_CACHE_PREFIX_RE.test(source) || !SW_STATIC_CACHE_RE.test(source)) {
    throw new Error(
      "[pdv:app-profile] public/sw.js precisa declarar `CACHE_PREFIX` e " +
        "`STATIC_CACHE` como const string — o build troca as duas pelo " +
        "profile. Sem isso os 4 apps dividem o mesmo CacheStorage e um " +
        "sobrescreve (ou apaga) o cache do outro.",
    );
  }
  return source
    .replace(
      SW_CACHE_PREFIX_RE,
      `const CACHE_PREFIX = ${JSON.stringify(meta.cachePrefix)};`,
    )
    .replace(
      SW_STATIC_CACHE_RE,
      `const STATIC_CACHE = ${JSON.stringify(staticCacheOf(meta))};`,
    );
}

function patchManifest(source, profile) {
  const meta = APP_PROFILES[profile];
  const base = JSON.parse(source);
  return `${JSON.stringify(
    {
      ...base,
      name: meta.name,
      short_name: meta.shortName,
      description: meta.description,
      // `./` é resolvido contra a URL do manifest, que fica na raiz do
      // outDir do app (`dist/kds/manifest.json` → `/kds/`). Assim o mesmo
      // manifest vale servido no desktop (o Tauri serve o `frontendDist` na
      // raiz da origem, `tauri://localhost`) e num deploy estático de
      // `dist/kds` — hardcodar `/kds/` quebraria o primeiro caso.
      start_url: "./",
      scope: "./",
    },
    null,
    2,
  )}\n`;
}

/**
 * Plugin do profile. Duas metades:
 *
 *   - `transformIndexHtml` (roda também no `dev`): troca o profile que a
 *     entry HTML carrega e reescreve título/manifest-title. É o que faz o app
 *     saber em qual entry subiu, sem deduzir da URL — que muda entre o web
 *     (`/kds/`) e o desktop (`tauri://localhost/`) e portanto não identifica
 *     nada.
 *   - `closeBundle`: reescreve `manifest.json` e `sw.js` no outDir. É o
 *     `closeBundle` e não o `generateBundle` de propósito — o `public/` é
 *     copiado no começo do build (dentro do `buildStart`), então só o
 *     `closeBundle` garante que a versão por profile é a última escrita.
 */
export function appProfilePlugin({ appProfile = ALL } = {}) {
  const profile = resolveAppProfile(appProfile);
  let root = process.cwd();
  let outDir = "dist";

  return {
    name: "pdv:app-profile",

    configResolved(config) {
      root = config.root;
      outDir = path.isAbsolute(config.build.outDir)
        ? config.build.outDir
        : path.resolve(root, config.build.outDir);
    },

    transformIndexHtml(html) {
      const effective = profile === ALL ? (readEntryProfile(html) ?? ALL) : profile;
      const meta = APP_PROFILES[effective];
      return html
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${meta.title}</title>`)
        .replace(
          /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/,
          `$1${meta.shortName}$2`,
        )
        .replace(ENTRY_META_RE, `$1${effective}$3`)
        .replace(
          ENTRY_SCRIPT_RE,
          `<script data-app-profile>window.__APP_PROFILE__ = ${JSON.stringify(effective)};</script>`,
        );
    },

    async closeBundle() {
      const [swSource, manifestSource] = await Promise.all([
        readFile(path.join(root, "public", "sw-v2.js"), "utf8"),
        readFile(path.join(root, "public", "manifest.json"), "utf8"),
      ]);

      // Sempre valida (o `patchStaticCache` estoura se as consts sumiram),
      // mas só escreve o que muda de verdade: no `all` o resultado é
      // idêntico ao que o `public/` já copiou, e o app de produção continua
      // recebendo os mesmos bytes de sempre.
      const swNext = patchStaticCache(swSource, profile);
      const manifestNext =
        profile === ALL ? manifestSource : patchManifest(manifestSource, profile);

      const pending = [];
      if (swNext !== swSource) pending.push(["sw-v2.js", swNext]);
      if (manifestNext !== manifestSource) pending.push(["manifest.json", manifestNext]);

      for (const [name, content] of pending) {
        await writeFile(path.join(outDir, name), content);
      }
    },
  };
}

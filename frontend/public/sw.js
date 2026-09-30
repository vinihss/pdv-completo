// Service worker mínimo. Propósito único: satisfazer o requisito de
// instalabilidade do PWA (Chrome/Android exige um SW com handler de fetch
// pra mostrar o prompt "Adicionar à tela inicial"). NÃO fazemos cache
// agressivo de dados — comandas, status de item, etc. precisam estar sempre
// atualizados, então a estratégia é sempre buscar da rede primeiro.
// Assets estáticos (JS/CSS com hash no nome, gerados pelo Vite) usam
// cache-first, já que o hash muda quando o conteúdo muda.
//
// CACHE_PREFIX e STATIC_CACHE são trocados pelo `vite/app-profiles.js` no
// build: os 4 apps (caixa/cozinha/garçom/entregador) convivem na mesma
// origem e `caches` é por origem, então com o mesmo nome um app sobrescreve o
// cache do outro. Os prefixos também não podem se cruzar, porque a limpeza do
// `activate` abaixo apaga tudo que começa com o prefixo — um prefixo comum
// faria um app apagar o cache dos outros só por assumir. O build `all` (app
// único) sai com `pdv-static-v`/`pdv-static-v1`, que não casa com nenhum
// prefixo de app isolado.

const CACHE_PREFIX = "pdv-static-v";
const STATIC_CACHE = `${CACHE_PREFIX}v1`;

// O sw.js mora na raiz do app (`dist/sw.js` no app único,
// `dist/kds/sw.js` no app da cozinha), então a pasta dele é a base do build
// — e é por isso que o prefixo de `/assets/` sai daqui em vez de ser fixo.
// Sem isso o app publicado em `/kds/` deixaria de acertar o cache-first dos
// assets e cairia no network-first da navegação. Já `/api` e `/realtime` são
// absolutos na origem (o Caddy/nginx serve a API na raiz) e não se movem.
const APP_BASE = new URL("./", self.location).pathname;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE)
          .map((k) => caches.delete(k)),
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Nunca intercepta API ou WebSocket — sempre rede, sempre fresco.
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/realtime")) {
    return;
  }

  // Assets com hash no nome (`assets/*`) — cache-first, são imutáveis.
  if (url.pathname.startsWith(`${APP_BASE}assets/`)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  // Resto (navegação, index.html) — network-first com fallback pro cache
  // se estiver offline (só evita tela em branco; a maior parte do app não
  // funciona sem conexão mesmo, já que depende de dados ao vivo).
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

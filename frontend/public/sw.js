// Service worker mínimo. Propósito único: satisfazer o requisito de
// instalabilidade do PWA (Chrome/Android exige um SW com handler de fetch
// pra mostrar o prompt "Adicionar à tela inicial"). NÃO fazemos cache
// agressivo de dados — comandas, status de item, etc. precisam estar sempre
// atualizados, então a estratégia é sempre buscar da rede primeiro.
// Assets estáticos (JS/CSS com hash no nome, gerados pelo Vite) usam
// cache-first, já que o hash muda quando o conteúdo muda.

const STATIC_CACHE = "pdv-static-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)))
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

  // Assets com hash no nome (/assets/*) — cache-first, são imutáveis.
  if (url.pathname.startsWith("/assets/")) {
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

# ============================================================
# App público de pedidos (apps/pedido-public) — build + nginx
# ============================================================
# Este app NÃO é uma cópia do frontend: ele serve o MESMO código de
# `frontend/src` (a página `pages/customer-menu`) através do alias `@/`, e só
# o que é próprio dele — bootstrap, tenant, client HTTP — mora em
# `apps/pedido-public/src`. Por isso o `npm ci` é feito DOIS VEZES, em dois
# diretórios, e o motivo é a resolução de imports do Vite, não o lockfile:
#
#   1. `apps/pedido-public/node_modules` — o código PRÓPRIO do app. É de onde
#      saem `react`, `react-dom`, `react-router-dom`, `lucide-react`, `axios`,
#      `@tanstack/react-query` e `sonner` para `src/app/**`.
#
#   2. `frontend/node_modules` — o código COMPARTILHADO. O alias `@/` entrega
#      ao bundler arquivos de `frontend/src`, e um arquivo é resolvido a partir
#      do PRÓPRIO diretório: `frontend/src/pages/customer-menu/CustomerMenuPage.jsx`
#      importando `react` procura a partir de `frontend/src/...`, e o primeiro
#      `node_modules` que ele encontra é o do frontend. Sem este segundo
#      `npm ci` o build morre com
#      `[vite]: Rolldown failed to resolve import "react" from ".../frontend/src/pages/customer-menu/CustomerMenuPage.jsx"`
#      (medido: removendo este `npm ci` e desligando o `dedupe` do
#      vite.config.ts, o build morre em 1.06s com exatamente essa mensagem.
#      Com o `dedupe` ligado ele passa, porque a lista cobre hoje as TRÊS
#      dependências bare do grafo compartilhado — `react`, `react-router-dom` e
#      `lucide-react`. Instalar os dois deixa essa lista de `dedupe` deixar de
#      ser uma aposta no dia em que o grafo compartilhado importar mais um
#      pacote: ela é a rede de segurança, não o chicote.)
#
# Consequência que o `dedupe` resolve: com os dois `node_modules` na imagem,
# `react` existe em duas cópias, e `frontend/src/...` + `src/app/...` numa
# mesma árvore de hooks sem uma única instância de React. O `dedupe` do
# `vite.config.ts` amarra os dois lados na cópia deste app.
#
# Os dois `npm ci` não podem virar um só: sem `workspaces` na raiz (ver o
# `package.json` do repo) não existe um lockfile único que os cubra — e é
# justamente o `workspaces` na raiz que quebrou o `npm ci` do job
# `test-frontend`: ele passava a hoistar `vite@6` (que `apps/pedido-public`
# quer) para a raiz, de onde o `vitest` do frontend resolvia o `vite` no lugar
# do `vite@8`, e o `@vitejs/plugin-react@6` perdia o JSX automático.
# Dois `npm ci` separados, dois lockfiles versionados, zero workspaces.
# ============================================================
FROM node:22-slim AS builder

WORKDIR /app

# Só os manifestos primeiro: é o que dá cache de camada no `npm ci` e mantém
# a cópia dos fontes (que muda a cada commit) fora do passo de instalação.
COPY frontend/package.json frontend/package-lock.json ./frontend/
COPY apps/pedido-public/package.json apps/pedido-public/package-lock.json ./apps/pedido-public/

RUN cd frontend && npm ci
RUN cd apps/pedido-public && npm ci

# Fontes. Do frontend só interessa `src/` — é o alvo do alias `@/`. O
# `frontend/src-tauri/`, os 4 HTML de profile e o resto do app interno não são
# lidos por este build.
COPY frontend/src ./frontend/src
COPY apps/pedido-public ./apps/pedido-public

# `npm run build` aqui, e não o `build:pedido` da raiz: os dois scripts são o
# mesmo comando, mas este não depende do `package.json` da raiz estar na imagem.
WORKDIR /app/apps/pedido-public
RUN npm run build

# ============================================================
# Stage 2: serve o dist com nginx
# ============================================================
FROM nginx:1.27-alpine AS runner

COPY --from=builder /app/apps/pedido-public/dist /usr/share/nginx/html
COPY apps/pedido-public/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
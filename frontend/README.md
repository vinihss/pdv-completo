# PDV — Frontend

App React (Vite) para o PDV Restaurante/Pub. Instalável como PWA e disponível como app Windows (Tauri).

## Guias para agentes

- **Convenções frontend**: `docs/agent-frontend.md` (FSD, camadas, componentes, overlays, menu, Tauri)
- **Mapa de telas**: `docs/agent-frontend-map.md` (em breve)
- **Testes**: `docs/agent-testing.md`

## Rodando localmente

Requer Node.js 20+ e o backend rodando em `localhost:3000`.

```bash
npm install
npm run dev                # http://localhost:5173
```

O Vite já proxeia `/api` e `/realtime` para `localhost:3000` (`vite.config.js`).

No `dev` as 4 entradas ficam disponíveis: `/`, `/kds.html`, `/garcon.html` e `/entregador.html`.

## Os 4 apps

Um build só, quatro apps Tauri (caixa, cozinha, garçom, entregador) — o **mesmo**
código React nas 4 entradas (`index.html`, `kds.html`, `garcon.html`,
`entregador.html`), sem app duplicado. O que muda por app é o `outDir` e o PWA
(`manifest.json` + cache do service worker, que são por origem e se sobrescrevem
se compartilhados). Detalhes em `vite/app-profiles.js`; qual entrada abriu o app
está em `src/shared/lib/appProfile.js` (`window.__APP_PROFILE__`, injetado no
HTML — não se deduz da URL, que no desktop é `tauri://localhost`).

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento (Vite) |
| `npm run build` | App único em `dist/index.html` — é o que o app de produção consome (`frontendDist: "../dist"`) |
| `npm run build:all` | Igual ao `build`, explicitado |
| `npm run build:pdv` | App da caixa em `dist/pdv/` |
| `npm run build:kds` | App da cozinha em `dist/kds/` |
| `npm run build:garcon` | App do garçom em `dist/garcon/` |
| `npm run build:entregador` | App do entregador em `dist/entregador/` |
| `npm run preview` | Preview do build de produção |
| `npm run lint` | oxlint |
| `npm run test` | vitest (jsdom + Testing Library) |
| `npm run desktop:build` | Build do app desktop (Tauri) |

Cuidado com o nome: **`build:all` é o app único**, não "os 4". O `all` é o
profile padrão e significa que as 4 entradas saem lado a lado em `dist/`. Para
publicar os 4 apps separados, rode os 4 `build:<profile>` (cada um esvazia só o
seu diretório) — o `dist/index.html` do `build` continua lá.


## Estrutura (FSD)

```
src/
├── app/           # bootstrap: router + providers
├── pages/         # telas por papel (pdv, manager, kitchen, cashier, courier, login)
├── widgets/       # blocos reusados (order-board, cash-drawer, app-menu, alert-bell)
├── features/      # ações do usuário (orders)
├── entities/      # domínio: api + model + ui
└── shared/        # genérico: api/http, components, hooks, lib
```

Ver `docs/agent-frontend.md` para o guia completo de convenções e arquitetura.

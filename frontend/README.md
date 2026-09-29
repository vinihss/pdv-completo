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

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento (Vite) |
| `npm run build` | Build de produção → `dist/` |
| `npm run preview` | Preview do build de produção |
| `npm run lint` | oxlint |
| `npm run test` | vitest (jsdom + Testing Library; 34 suítes) |
| `npm run desktop:build` | Build do app desktop (Tauri) |

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

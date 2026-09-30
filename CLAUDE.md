# Instruções para Claude Code

Projeto: PDV Restaurante/Pub (backend Node.js + frontend React)

## Leia antes de começar

1. `AGENTS.md` — guia de trabalho essencial
2. `docs/agent-backend.md` — convenções backend detalhadas
3. `docs/agent-frontend.md` — convenções frontend detalhadas
4. `docs/agent-testing.md` — como rodar testes

## Convenções gerais

- Idioma do repositório: **PT-BR** (docs, comentários, UI, mensagens)
- Backend: ESM + NodeNext (imports com extensão `.js`)
- Frontend: FSD (Feature-Sliced Design), sem TypeScript, sem lib de estado

## Backend

- **Camadas**: `domain` → `application` → `infra` → `http`
- **Transações**: todo acesso dentro de `db.transaction` é `await tx...`
- **Migrations**: próximo número é `0005_*`. Escrever idempotente. O boot falha se a migration falhar
- **Erros**: usar `AppError` com código do catálogo em `src/domain/errors.ts`
- **Idempotência**: endpoints marcados devem usar `withIdempotency` com `correlationId`
- **Lock otimista**: toda mutação de `order_item` exige `expectedVersion`
- **Estoque é ledger**: saldo = soma dos `quantity_delta` de `stock_movement`
- **Audit log + outbox na mesma transação** da escrita de domínio
- **Sem lint/typecheck** — rode `npm run build` (tsc) para validar

## Frontend

- **FSD**: `app → pages → widgets → features → entities → shared`
- **Sem lib de estado**: server-authoritative, mutation `await` + reload via REST
- **Realtime**: usar `useRealtime(token, rooms, onEvent, onReconnect)` — token como subprotocol
- **Mutations**: aguardar e recarregar; sem otimismo
- **Botão de ação fora do `<form>`**: vincular por `form="<idForm>"` + `noValidate`
- **UI em PT-BR**; ícones via `lucide-react`; estilos com Tailwind 4
- **Sobreposição tem dono**: `Modal`, `Drawer`, `ScreenHeader` ou `ConfirmModal` — nada de overlay ad-hoc
- **Menu principal = accordion** na esquerda (desktop) ou `Drawer` (mobile)
- **Login por PIN**: envio explícito (botão ou Enter), sem auto-envio em 6 dígitos
- Rodar `npm run lint` (oxlint) antes de terminar

## Testes

- Backend: `npm run test` (vitest, 16 suítes, Postgres dedicado `pdv_test`)
- Frontend: `npm run test` (vitest, 34 suítes, jsdom + Testing Library)
- Printer: `go test ./...` em `printer/daemon/`

## Documentação

- Specs do produto: `docs/00-overview.md` até `docs/12-*.md`
- Guias para agentes: `docs/agent-backend.md`, `docs/agent-frontend.md`, `docs/agent-deploy.md`, `docs/agent-testing.md`
- Índice de endpoints: `docs/agent-api-index.md`
- Mapa de módulos: `docs/agent-backend-map.md`, `docs/agent-frontend-map.md`


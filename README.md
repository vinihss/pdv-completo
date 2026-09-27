[![Deploy on Tag](https://github.com/vinihss/pdv-completo/actions/workflows/deploy-on-tag.yml/badge.svg)](https://github.com/vinihss/pdv-completo/actions/workflows/deploy-on-tag.yml)

# PDV — Restaurante/Pub

Implementação completa (backend real + frontend consumindo a API, sem mocks)
das specs em `docs/`. Ver `docs/00-overview.md` pra contexto do produto.

## Estrutura

```
backend/    API REST + WebSocket (Node.js + TypeScript + Fastify + Drizzle + PostgreSQL)
frontend/   App React (Vite) — login, garçom, cozinha, gerente — instalável como PWA
deploy/     Deploy em nuvem: Dockerfiles, Caddy (HTTPS automático), docker-compose
docs/       Specs originais (backend, frontend, critérios de aceite)
```

## Rodando localmente

Requer Node.js 20+.

### 1. Backend

Precisa de um PostgreSQL 16 acessível (em dev,
`docker compose -f deploy/docker-compose.dev.yml up -d postgres`).

```bash
cd backend
npm install
cp .env.example .env      # ajuste DATABASE_URL e JWT_SECRET
npm run seed               # aplica migrations + dados de demonstração
npm run dev                 # http://localhost:3000
```

O seed cria 4 usuários de teste:

| Nome | Perfil | PIN |
|---|---|---|
| Ana Ribeiro | Garçom | 1234 |
| Carlos Lima | Garçom | 5678 |
| Roberto Alves | Gerente | 9999 |
| Estação Cozinha | Cozinha | 0000 |

Health check: `GET http://localhost:3000/health`

### 2. Frontend

Em outro terminal:

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

O Vite já vem configurado com proxy (`vite.config.js`) pra `/api` e `/realtime`
apontando pro backend em `localhost:3000` — não precisa configurar CORS nem URL
manualmente em dev.

Abra `http://localhost:5173`, selecione um usuário e entre com o PIN.

No celular, abra a mesma URL (trocando `localhost` pelo IP/domínio real) e
use "Adicionar à tela inicial" — o app já é um PWA instalável (ver
`frontend/public/manifest.json`), o garçom abre como se fosse um app nativo,
sem precisar de loja de aplicativos.

## Deploy em nuvem

Pra disponibilizar o app pros garçons de qualquer lugar (não só na rede
Wi-Fi do estabelecimento), veja **`deploy/README.md`** — runbook completo
com Docker Compose + Caddy (HTTPS automático via Let's Encrypt), backup do
banco, e o script de seed de produção (`seed-prod.ts`, sem dados fictícios).


### Build de produção do frontend

```bash
cd frontend
npm run build     # gera dist/ — sirva atrás de um proxy reverso que também
                   # encaminhe /api e /realtime pro backend (nginx, Caddy, etc.)
```

## O que está implementado

**Backend** — todos os endpoints de `01-backend-spec.md` §7: autenticação por
PIN (argon2 + JWT + lockout), comandas (abrir/lançar item em lote/mudar
status/remover/pagamento/fechar), produtos, categorias, usuários, clientes,
relatório de vendas, audit log, store-settings. Lock otimista por item
(`version`), idempotência via `correlationId`, outbox pattern pra WebSocket em
tempo real, migrations automáticas no boot, seed de desenvolvimento.

**Frontend** — login por PIN, tela do garçom (lista de comandas, abrir nova,
adicionar item em lote com revisão, marcar entregue, pagamento, fechar com
bloqueio se houver item pendente), tela da cozinha (tempo real via
WebSocket, cronômetro com escalada de cor), tela do gerente (mesma tela de
comandas do garçom + configurações + cadastros de categoria/produto +
equipe/PINs + relatório de vendas + auditoria).

Cozinha é condicional a `store_settings.kitchen_enabled`, igual descrito no
overview — desligar em Configurações remove a etapa "pronto" do fluxo em
tempo real, sem precisar de outro build.

## Nota técnica: transações são assíncronas

O Postgres é o único banco suportado (o SQLite foi removido). O driver
`node-postgres` é I/O, então todo acesso dentro de
`db.transaction(async (tx) => ...)` é `await tx...`: os terminais síncronos
(`.run()`, `.get()`, `.all()`, `.sync()`) não existem mais. Query de uma linha
precisa de destructuring (`const [row] = await tx.insert(...).returning()`) e
agregação de `const rows = await ...` usa `rows[0]`. Está documentado em
`backend/src/application/order/order.usecases.ts`.

O schema é uma migration só (`backend/migrations/0001_init.sql`), aplicada
pelo runner com advisory lock — rodando em todo boot em modo local e via
`npm run db:migrate` em produção.

## O que ainda não existe (deixado como está na spec)

- Buffer de eventos perdidos no reconnect do WebSocket (`sync.request` responde
  vazio) — o client recarrega via REST ao reconectar, o que cobre o caso na
  prática mas não é o mecanismo de sync completo descrito na §8.
- Geração de QR Pix (BR Code) — o campo existe em store-settings mas não há
  endpoint de geração de QR.
- Backup automático: `deploy/backup.sh` faz `pg_dump` sob demanda, mas o agendamento
  (cron) e o envio das cópias pra fora do servidor são do operador.

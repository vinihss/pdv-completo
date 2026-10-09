[![Deploy on Tag](https://github.com/vinihss/pdv-completo/actions/workflows/deploy-on-tag.yml/badge.svg)](https://github.com/vinihss/pdv-completo/actions/workflows/deploy-on-tag.yml)

# PDV — Restaurante/Pub

Implementação completa (backend real + frontend consumindo a API, sem mocks)
das specs em `docs/`. Ver `docs/00-overview.md` pra contexto do produto.

**Documentação por tarefa:** consulte [`docs/README.md`](docs/README.md) para encontrar guias de produto, desenvolvimento, testes, operações e agentes. Para contribuir, veja [`CONTRIBUTING.md`](CONTRIBUTING.md).

> **Desenvolvimento local:** o seed cria usuários e dados fictícios. Nunca use esses PINs nem rode `npm run seed` em produção. A documentação não concede autorização para acessar ou alterar banco de produção.

## Estrutura

```
backend/    API REST + WebSocket (Node.js + TypeScript + Fastify + Drizzle + PostgreSQL)
frontend/   App React (Vite) — login, garçom, cozinha, gerente — instalável como PWA
            (também é o bundle servido pelos apps standalone)
frontend/src-tauri/  App desktop v1 (Tauri) — desacoplado do web app, em manutenção
standalone-pdv/  App Caixa (Tauri): renderizador ESC/POS em Rust (src/printing/)
            — o daemon Go de impressão saiu deste repositório
deploy/     Deploy em nuvem: Dockerfiles, Caddy (HTTPS automático), docker-compose
docs/       Specs originais (backend, frontend, critérios de aceite)
```

> Os apps mobile (Garçom/Entregador, React Native/Expo) **não estão mais neste
> repositório** — vivem no projeto separado **`pdv-mobile-apps`**
> (`~/Downloads/pdv-mobile-apps`), com o doc 22 da migração RN.

## Modos de execução

| Modo | Comando | URL | HTTPS | Hot reload | Uso |
|---|---|---|---|---|---|
| **A. Dev local (Node direto)** | `scripts/dev/setup-dev.sh` ou manual | `localhost:5173` | não | sim | Desenvolvimento rápido |
| **B. Dev Docker** | `docker compose -f deploy/docker-compose.dev.yml up -d` | `localhost` | não | sim | Desenvolvimento com Docker |
| **C. Local produção-like** | `docker compose -f deploy/docker-compose.local.yml up -d` | `localhost` | não | não | Testar stack completo |
| **D. Produção em nuvem** | `deploy/switch.sh` | domínio | sim | não | Deploy real |

---

## Modo A — Dev local (Node direto)

Requer Node.js 20+ e PostgreSQL 16.

### Setup automatizado

```bash
./scripts/dev/setup-dev.sh
```

O script verifica dependências, cria `.env`, instala pacotes, sobe o Postgres
via Docker, roda o seed e inicia backend + frontend.

### Setup manual

**1. Backend**

Precisa de um PostgreSQL 16 acessível. Para subir só o banco via Docker:

```bash
docker compose -f deploy/docker-compose.dev.yml up -d postgres
```

Depois:

```bash
cd backend
npm install
cp .env.example .env      # ajuste DATABASE_URL e JWT_SECRET
npm run seed               # aplica migrations + dados de demonstração
npm run dev                 # http://localhost:3000
```

O seed de desenvolvimento cria usuários de teste (os perfis e PINs podem mudar; confira a saída e o código atual do seed):

| Nome | Perfil | PIN |
|---|---|---|
| Ana Ribeiro | Garçom | 1234 |
| Carlos Lima | Garçom | 5678 |
| Roberto Alves | Gerente | 9999 |
| Caixa Teste | Caixa | 2468 |
| Estação Cozinha | Cozinha | 0000 |

Health check: `GET http://localhost:3000/health`

**2. Frontend**

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

---

## Modo B — Dev Docker (hot reload)

Sobe o stack completo com Docker Compose, com bind mounts que refletem alterações
no código sem precisar rebuild.

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

- **URL**: `http://localhost` (Caddy)
- **Hot reload**: sim (tsx watch + Vite HMR)
- **Postgres**: incluído no compose

Para ver logs:

```bash
docker compose -f deploy/docker-compose.dev.yml logs -f
```

Para parar:

```bash
docker compose -f deploy/docker-compose.dev.yml down
```

### Atualizar containers com código atual

Quando puxar novas alterações da branch:

```bash
git pull
docker compose -f deploy/docker-compose.dev.yml up -d --build
```

---

## Modo C — Local produção-like

Sobe o stack completo com Caddy, backend e frontend, sem HTTPS. Útil para testar
o fluxo de deploy localmente antes de ir pro VPS.

```bash
cd deploy
cp .env.example .env       # ajuste DOMAIN, JWT_SECRET, etc.
docker compose -f docker-compose.local.yml up -d
```

- **URL**: `http://localhost` (ou `http://<IP-da-maquina-na-LAN>`)
- **HTTPS**: não
- **Hot reload**: não

Para parar:

```bash
docker compose -f deploy/docker-compose.local.yml down
```

---

## Modo D — Produção em nuvem

Pra disponibilizar o app pros garçons de qualquer lugar (não só na rede
Wi-Fi do estabelecimento), veja **`deploy/README.md`** — runbook completo
com Docker Compose + Caddy (HTTPS automático via Let's Encrypt), backup do
banco, e o script de seed de produção (`seed-prod.ts`, sem dados fictícios).

Resumo do deploy:

```bash
cd deploy
cp .env.example .env       # ajuste DOMAIN, JWT_SECRET, etc.
./install.sh               # instalação inicial
./switch.sh                # deploys subsequentes (sem downtime)
```

---

## Frontend standalone

O build de produção do frontend pode ser servido separadamente do backend:

```bash
cd frontend
npm run build     # gera dist/
```

O `dist/` é conteúdo estático puro. Sirva com qualquer servidor (nginx, Caddy,
etc.) e configure proxy reverso para `/api` e `/realtime` apontando para o backend.

Casos de uso:
- Servir o frontend em um servidor separado do backend
- Usar com o app desktop (Tauri) — o frontend é empacotado e o backend roda remoto
- Servir como PWA estático com backend em outro domínio

---

## Impressora (daemon ESC/POS)

O backend envia pedidos via HTTP para o daemon de impressão, que imprime em
impressoras ESC/POS (Elgin MP-4200). O frontend não precisa conhecer ESC/POS —
apenas envia dados estruturados para `http://127.0.0.1:8080/api/print`. O
**daemon (Go) saiu deste repositório** e está sendo reescrito à parte; aqui
ficam o contrato de integração e o renderizador ESC/POS em Rust do app Caixa
(`standalone-pdv/src/printing/`).

### Configuração

Edite `config.json` com o IP da impressora:

```json
{
  "listen": "127.0.0.1:8080",
  "printers": {
    "kitchen": {
      "address": "192.168.1.50:9100",
      "template": "kitchen-default"
    }
  }
}
```

### Acentos (code page)

Térmicas ESC/POS **não entendem UTF-8**. Cada perfil aceita dois campos:

```json
"kitchen": {
  "address": "192.168.1.50:9100",
  "template": "kitchen-default",
  "encoding": "cp850",
  "code_page": 2
}
```

| `encoding` | `ESC t n` | Quando |
|---|---|---|
| `cp850` (padrão, ou ausente) | 2 | padrão das térmicas de 80mm |
| `cp858` | 19 | igual ao CP850 **com euro** no 0xD5 |
| `windows-1252` | 16 | página do Windows |
| `utf-8` | — | **não converte**; só para impressora com fonte UTF-8 |

Ausente ou vazio = `cp850`. O `code_page` sobrescreve o número do `ESC t` quando
o modelo não segue a tabela Epson — é último recurso, porque o sintoma (texto
ilegível) aparece longe da causa (o `config.json`).

Ocupado antes do texto, o `\n` sobrevive e o `\t` vira espaço. Tudo que é byte de
controle (0x00-0x1F, 0x7F) é descartado: sem isso, um nome de item com `ESC`
injetaria comando na impressora e o cupom sairia cortado no meio.

Teste com um pedido contendo `Ç Ã Õ É` na impressora real. Se sair errado,
ajuste `code_page` conforme o manual do modelo.

#### O app desktop tem os mesmos campos

O app Caixa (`standalone-pdv`) renderiza localmente e **não** passa pelo daemon,
então tem a sua própria config (`%ProgramData%\PDV\app.json`) com os mesmos
nomes e os mesmos valores:

```json
"printers": {
  "kitchen": {
    "transport": "tcp",
    "socket": "192.168.1.50:9100",
    "encoding": "cp850",
    "code_page": 2
  }
}
```

O renderizador Rust é preso ao golden byte a byte
(`standalone-pdv/tests/golden.rs`), então qualquer divergência de bytes quebra o CI.

### Integração no frontend

```javascript
const PRINTER_DAEMON = 'http://127.0.0.1:8080';

await fetch(`${PRINTER_DAEMON}/api/print`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    job_id: `${pedido.id}-kitchen`,
    order_id: pedido.id,
    destination: 'kitchen',
    order: { /* dados do pedido */ }
  })
});
```

O contrato com o daemon é o mesmo que o backend usa (`PRINTER_DAEMON_URL`,
rotas em `print.routes.ts`). Como o daemon foi para fora deste repositório, os
detalhes de templates/retry/config dele moram na reescrita à parte.

---

## Scripts úteis

| Script | Onde | O que faz |
|---|---|---|
| `scripts/dev/setup-dev.sh` | raiz | Setup automatizado do modo A (Node direto) |
| `deploy/switch.sh` | deploy | Deploy sem downtime (azul/verde) |
| `deploy/install.sh` | deploy | Instalação inicial no VPS |
| `deploy/run-cloud.sh` | deploy | Sobe stack em modo cloud (Postgres externo) |
| `deploy/backup.sh` | deploy | Backup do banco (pg_dump) |
| `deploy/backup-fetch.sh` | deploy | Download do backup |
| `deploy/probe-availability.sh` | deploy | Mede downtime real |
| `deploy/switch.sh` | deploy | deploy sem downtime (azul/verde) |

---

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

**Impressora** — daemon Go para impressão térmica ESC/POS com fila SQLite,
retry automático, templates JSON editáveis e integração via HTTP local.

Cozinha é condicional a `store_settings.kitchen_enabled`, igual descrito no
overview — desligar em Configurações remove a etapa "pronto" do fluxo em
tempo real, sem precisar de outro build.

---

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

---

## O que ainda não existe (deixado como está na spec)

- Buffer de eventos perdidos no reconnect do WebSocket (`sync.request` responde
  vazio) — o client recarrega via REST ao reconectar, o que cobre o caso na
  prática mas não é o mecanismo de sync completo descrito na §8.
- Geração de QR Pix (BR Code) — o campo existe em store-settings mas não há
  endpoint de geração de QR.
- Backup automático: `deploy/backup.sh` faz `pg_dump` sob demanda, mas o agendamento
  (cron) e o envio das cópias pra fora do servidor são do operador.

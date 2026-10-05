[![Deploy on Tag](https://github.com/vinihss/pdv-completo/actions/workflows/deploy-on-tag.yml/badge.svg)](https://github.com/vinihss/pdv-completo/actions/workflows/deploy-on-tag.yml)

# PDV — Restaurante/Pub

Implementação completa (backend real + frontend consumindo a API, sem mocks)
das specs em `docs/`. Ver `docs/00-overview.md` pra contexto do produto.

## Estrutura

```
backend/    API REST + WebSocket (Node.js + TypeScript + Fastify + Drizzle + PostgreSQL)
frontend/   App React (Vite) — login, garçom, cozinha, gerente — instalável como PWA
            (também é o bundle servido pelos apps standalone)
frontend/src-tauri/  App desktop v1 (Tauri) — desacoplado do web app, em manutenção
printer/    Daemon Go para impressão térmica (ESC/POS)
deploy/     Deploy em nuvem: Dockerfiles, Caddy (HTTPS automático), docker-compose
docs/       Specs originais (backend, frontend, critérios de aceite)
```

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

O seed cria 5 usuários de teste:

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

O daemon Go em `printer/` recebe pedidos via HTTP e imprime em impressoras
ESC/POS (Elgin MP-4200). O frontend não precisa conhecer ESC/POS — apenas envia
dados estruturados para `http://127.0.0.1:8080/api/print`.

### Instalação rápida (desenvolvimento)

```bash
cd printer/daemon
cp config.example.json config.json
go run .
```

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

### Instalação como serviço

**Linux:**

```bash
sudo ./printer/scripts/install-linux.sh
sudo nano /etc/pdv-printer/config.json
sudo systemctl restart pdv-printer
```

**Windows** (PowerShell como Administrador):

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\printer\scripts\install-windows.ps1
notepad "$env:ProgramData\PDV Printer\config.json"
Restart-Service PDVPrinterDaemon
```

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

Para detalhes completos (templates, retry, status da impressora, múltiplas
impressoras), ver **`printer/README.md`**.

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
| `scripts/build/build-app.sh` | `frontend/` | Build do app desktop v1 (Tauri): `--release` para entrega, `--appimage-docker` para AppImage |
| `printer/scripts/install-linux.sh` | printer | Instala daemon como serviço Linux |
| `printer/scripts/install-windows.ps1` | printer | Instala daemon como serviço Windows |

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

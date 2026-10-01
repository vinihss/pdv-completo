# Guia de Deploy

Resumo do runbook completo em `deploy/README.md`.

## Visão geral

Deploy azul/verde com gap HTTP zero usando Docker Compose + Caddy (HTTPS automático via Let's Encrypt).

## Estrutura

```
deploy/
├── docker-compose.yml         # produção (backend + frontend + caddy)
├── docker-compose.dev.yml     # desenvolvimento (postgres + backend + frontend)
├── docker-compose.local.yml   # stack local completo
├── Caddyfile                  # config do proxy (upstream por variável)
├── Caddyfile.dev
├── Caddyfile.local
├── caddy-assemble.sh          # monta a Caddyfile efetiva dentro do container
├── switch.sh                  # deploy sem downtime (switch/install/rollback/status)
├── probe-availability.sh      # mede o gap de downtime real
├── backup.sh                  # pg_dump sob demanda
├── backup-fetch.sh            # baixa backup do servidor
├── install.sh                 # seed de produção + load-menu
├── reset.sh                   # reseta o stack
├── run-cloud.sh               # sobe o stack em modo cloud
├── state/active-upstream      # ponteiro de 2 linhas (backend ou backend-next)
├── .env.example
└── README.md                  # runbook completo (33 KB)
```

## Comandos essenciais

| Comando | O que faz |
|---|---|
| `./switch.sh` | Deploy sem downtime (instância nova + `caddy reload`) |
| `./switch.sh --status` | Mostra qual instância está ativa |
| `./switch.sh --rollback` | Reverte para a instância anterior |
| `./switch.sh --install` | Instala sem rebuild (usa imagem existente) |
| `./switch.sh --no-build` | Switch sem rebuild |
| `./probe-availability.sh --url <url> --seconds N` | Mede o gap de downtime real (sai != 0 se houve falha) |
| `bash deploy/backup.sh` | Faz pg_dump do banco |
| `bash deploy/install.sh` | Seed de produção + load-menu |

## Regras que não mudam

### Healthcheck é o portão

- `/health` só responde depois das migrations (`runMigrations()` antes do `app.listen`)
- Verde = schema aplicado
- Verde doente → o switch aborta **antes** do reload, com o proxy velho no ar
- **Nunca** remover o healthcheck do backend nem do frontend esperando "confiar no log"

### Sem `lb_retries` no Caddy

- Retentativa repetiria POST (pagamento, lançamento de item)
- O gap zero vem da ordem (healthcheck antes do reload), não de retry

### `stream_close_delay 5m` em `/realtime*`

- O `reload` fecha todos os WebSockets (caddyserver/caddy#6420, #7222)
- O `stream_close_delay` adia o fechamento e segura quem estava conectado durante o drain
- **Não remover**

### Caddyfile com upstream por variável

- A Caddyfile do repo tem `{$PDV_BACKEND_UPSTREAM:backend:3000}`
- Quem monta a config efetiva é `deploy/caddy-assemble.sh`, **dentro** do container, a partir do ponteiro de 2 linhas `deploy/state/active-upstream`
- O host não gera Caddyfile
- O compose monta o **diretório** `deploy/` (`./:/srv/pdv-deploy:ro`), não arquivo: o `git checkout -f` da tag troca o inode do arquivo e um mount de arquivo deixaria o proxy servindo a config antiga em silêncio

### `git checkout -f` reverte `deploy/state/active-upstream`

- Por isso o CI salva/restaura o ponteiro antes do switch (o switch lê esse arquivo para saber de que lado está o tráfego)

### Migrations expand/contract

- A verde roda as migrations no boot (`DEPLOYMENT_MODE=local` default em `docker-compose.yml`)
- A versão antiga precisa continuar compatível com o schema novo (é o alvo do `--rollback`)

## Pendência conhecida

**Um dono só do outbox**: durante o drain (~5s) um cliente cujo WS está na instância antiga pode perder um evento de outbox reivindicado pela nova; o `onReconnect` do `useRealtime` recompõe por REST em ~250ms. Fechar a janela exige **um dono só do outbox** (advisory lock do Postgres para eleger líder, ou `LISTEN/NOTIFY`).

> **A coordenação agora existe; a janela de perda, não.** Os três ciclos
> (dispatcher do outbox, maintenance, polling do iFood) abrem uma transação
> com `pg_try_advisory_xact_lock(hashtext(<chave>))` no topo e só rodam se
> ganharem o lock; perdedor pula o ciclo em silêncio. As chaves, e a razão de
> o lock ser **de transação** e não de sessão, estão em
> `backend/src/infra/locks.ts`. Na prática o blue/green já garante uma
> instância só, então isto é a rede de segurança para o caso em que as duas
> apontem para o mesmo banco ao mesmo tempo (deploy manual, sobreposição de
> drain, dev local apontado para o banco de produção).
>
> O que **continua valendo**: durante o drain a instância antiga pode ainda
> estar com o lock e a nova ainda não o pegou. A janela de perda de evento só
> fecha com o `onReconnect` recompõe por REST — que é o comportamento atual,
> não uma regressão.

## Medições

Últimas medições no stack local: 4 switches, 861 requisições, 0 falhas, 100% de disponibilidade, maior gap 0,0s; WebSocket reconectando em 293ms.

## Backup

- `deploy/backup.sh` faz `pg_dump` sob demanda
- **Pendência**: agendar o cron e copiar as cópias pra fora do servidor
- `deploy/backup-fetch.sh` baixa o backup do servidor

## Seed de produção

- `deploy/install.sh` roda o seed de produção (sem dados fictícios) + load-menu
- O seed de produção cria apenas o usuário gerente inicial

# Guia de Deploy

Resumo do runbook completo em `deploy/README.md`.

## Visão geral

Deploy azul/verde com gap HTTP zero usando Docker Compose + Caddy (HTTPS automático via Let's Encrypt).

## Estrutura

```
deploy/
├── docker-compose.yml         # produção (postgres + backend + frontend + caddy + ws-gateway[profile])
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
├── state/active-upstream      # ponteiro de 3 chaves (duas do azul/verde + PDV_WS_UPSTREAM, que é override)
├── .env.example
└── README.md                  # runbook completo (o guia de referência)
```

O serviço `ws-gateway` não tem arquivo aqui: a fonte é o módulo Go
`ws-gateway/` (irmão do `printer/`), e o compose o builda a partir de
`../ws-gateway`. Ele existe **nos três** compose e está atrás de
`profiles: ["ws-gateway"]` — o `up` normal não o cria. Ver
[Gateway WebSocket em Go](#gateway-websocket-em-go-opt-in).

## Comandos essenciais

| Comando | O que faz |
|---|---|
| `./switch.sh` | Deploy sem downtime (instância nova + `caddy reload`). **Não** mexe no `ws-gateway` |
| `./switch.sh --status` | Mostra qual instância está ativa e quem serve o `/realtime*` |
| `./switch.sh --rollback` | Reverte para a instância anterior (backend/frontend; não mexe no gateway) |
| `./switch.sh --install` | Instala sem rebuild (usa imagem existente) |
| `./switch.sh --no-build` | Switch sem rebuild |
| `./probe-availability.sh --url <url> --seconds N` | Mede o gap de downtime real (sai != 0 se houve falha) |
| `docker compose --profile ws-gateway up -d --build ws-gateway` | Sobe **só** o gateway WS em Go — o `up` normal não o cria (está atrás de `profiles`) |
| `docker compose exec caddy sh /srv/pdv-deploy/caddy-assemble.sh reload` | Aplica a config do proxy sem derrubar WebSocket (caminho quente) |
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

- A Caddyfile do repo tem `{$PDV_BACKEND_UPSTREAM:backend:3000}` e, no bloco `/realtime*`, um upstream próprio, `{$PDV_WS_UPSTREAM:backend:3000}`
- Quem monta a config efetiva é `deploy/caddy-assemble.sh`, **dentro** do container, a partir do ponteiro `deploy/state/active-upstream` — **3 chaves**: `PDV_BACKEND_UPSTREAM` e `PDV_FRONTEND_UPSTREAM` (as duas do azul/verde, reescritas a cada switch) e `PDV_WS_UPSTREAM`, que só existe quando alguém a escreveu à mão
- As chaves são uma **allowlist** no script (`caddy-assemble.sh:44`): chave fora da lista é logada como `chave ignorada` e o proxy fica no default da Caddyfile. Chave nova entra no `case`, não no `.env`
- `caddy validate` é o portão do switch, mas **não resolve upstream** (ver armadilhas em [Gateway WebSocket em Go](#duas-armadilhas-do-validate)): ele pega sintaxe e chave errada, não nome de serviço errado
- O host não gera Caddyfile
- O compose monta o **diretório** `deploy/` (`./:/srv/pdv-deploy:ro`), não arquivo: o `git checkout -f` da tag troca o inode do arquivo e um mount de arquivo deixaria o proxy servindo a config antiga em silêncio

### `git checkout -f` reverte `deploy/state/active-upstream`

- Por isso o CI salva/restaura o ponteiro antes do switch (o switch lê esse arquivo para saber de que lado está o tráfego)

### Migrations expand/contract

- A verde roda as migrations no boot (`DEPLOYMENT_MODE=local` default em `docker-compose.yml`)
- A versão antiga precisa continuar compatível com o schema novo (é o alvo do `--rollback`)

## Gateway WebSocket em Go (opt-in)

O realtime (`/realtime*`) tem **duas** implementações: o `WsGateway` +
`outbox-dispatcher` do backend Node (o que está no ar) e o gateway em Go, em
`ws-gateway/`. Mesma rota, mesmo handshake, mesmas rooms, mesmo token — quem não
muda é o app. Runbook completo (ligar, desligar, diagnosticar) em
`deploy/README.md` §"Gateway WebSocket em Go"; aqui fica só o que muda a
topologia do deploy e o que já custou tempo.

### O serviço no compose

Presente nos três compose, idêntico no essencial:

| | |
|---|---|
| serviço | `ws-gateway`, `profiles: ["ws-gateway"]` — o `up`/`--install` normal **não** o cria (conferido com `docker compose config --services`) |
| build | contexto `../ws-gateway` (a fonte é o módulo Go, fora de `deploy/`), imagem `${WS_GATEWAY_IMAGE:-pdv-ws-gateway:local}` |
| porta | 8080 **só** na rede do compose — sem `ports:`, o Caddy é o único que fala com ele |
| ambiente | `DATABASE_URL` e `JWT_SECRET` (os mesmos do backend), `PORT=8080`, `WS_DISPATCH` (gate de posse do realtime, desligado por padrão), `WS_ALLOWED_ORIGINS` (vazio = qualquer origem), `GIT_SHA` (só aparece no `/health`) |
| banco e SIGTERM | `depends_on: postgres` com `service_healthy`; `stop_grace_period: 15s` porque o binário drena 10s no SIGTERM |
| escrita | nenhuma: só lê `outbox_event`. Sem migration, sem volume, sem estado em disco |

O `environment` acima é o que existia quando este guia foi escrito; o
`ws-gateway/` ainda ganha envs novas a cada mudança. Confirme no compose antes
de virar uma flag. O contrato do `/health` dele (quando responde 503, o que é o
campo `outboxEnabled` e por que sem `DATABASE_URL` ele é 200) está em
`deploy/README.md` §"O contrato do `/health`".

### Quem serve o `/realtime*`

O Caddy tem um upstream só para essa rota, resolvido dentro do container pelo
`caddy-assemble.sh` (`deploy/caddy-assemble.sh:53-83`), nesta ordem:

1. **`PDV_WS_UPSTREAM` no ponteiro** — o botão de emergência; vale até o
   próximo switch.
2. **`WS_BACKEND=go`** no ambiente do container (vem do `.env`,
   `deploy/docker-compose.yml:53`) — a decisão que sobrevive a recreate e a
   deploy. Default `node`.
3. **Sem nada disso, acompanha `PDV_BACKEND_UPSTREAM`** — o mesmo valor do
   backend, e **não** um literal.

O item 3 não pode ser um literal (`backend:3000`): o switch para a instância
antiga no passo 5, e um literal deixaria o `/realtime*` apontando para um
container parado já no primeiro deploy — todo WS quebrado com o resto do app
(REST) funcionando, que é o pior tipo de falha para diagnosticar. Verificado
rodando o script de verdade: com `PDV_BACKEND_UPSTREAM=backend-next:3000` e sem
flag, o log sai `realtime: backend-next:3000`.

Flag fora do catálogo (`WS_BACKEND=g0`) não é adivinhada: o script avisa
`[caddy] WS_BACKEND='...' não é node nem go` e cai no Node. O sintoma de uma
flag digitada errada é "nada mudou", indistinguível de "o gateway está com
problema" — sem o aviso o operador ia caçar bug no gateway.

### Duas armadilhas do `validate`

O `caddy validate` é o portão do switch (`caddy-assemble.sh:87-91`), mas o
Caddy resolve upstream **preguiçosamente**: o `validate` não abre conexão nem
consulta DNS, então **um nome de serviço errado passa**. Medido com
`caddy:2-alpine` na Caddyfile real:

- `PDV_WS_UPSTREAM=ws-gateay:8080` (typo no **valor**): `Valid configuration`,
  exit 0. O proxy sobe, o `reload` aplica, e só o `/realtime*` quebra — por
  requisição, depois do reload, com o resto do app intacto.
- Variável **definida e vazia**: valida do mesmo jeito, e o `caddy adapt` sai
  com um `reverse_proxy` **sem upstream nenhum** (medido). Por isso o
  `PDV_WS_UPSTREAM` do compose dev tem default explícito
  (`docker-compose.dev.yml:19-25`), e o `caddy-assemble.sh` trata vazio como
  ausente.

O portão **pega** chave errada no ponteiro (a allowlist do `caddy-assemble.sh:44`
loga `chave ignorada`) e porta não numérica (`ws-gateway:http` reprova com erro
de parse). O que ele **não** pega é o **nome** do serviço — nem com porta, nem
sem ela: `backend` e `:3000` também passam (medido). Confirme o destino pela
linha `upstream ativo` no log do Caddy e, antes de apontar o proxy para o
gateway, pelo `/health` dele: o gateway está fora do rodízio azul/verde, então
**não** existe healthcheck de instância nova que o cubra.

### Por que ele não sobe sozinho

O dispatcher do gateway disputa com o do Node o **mesmo** advisory lock do
outbox (`pdv:outbox:owner`) e marca o evento como publicado mesmo com zero
assinantes na room: o lock dá exclusão entre dispatchers, não exclusividade de
dono. Gateway de pé **fora** do `/realtime` ganha cerca de metade dos ciclos,
engole o evento de quem está conectado no Node, e o banco não denuncia — para o
evento, já está `published=true`. O sintoma é a tela do salão que não atualiza,
sem erro em log nenhum, porque o `useRealtime` só recompõe por REST na
reconexão (isto é, no F5 seguinte).

Daí o `profiles: ["ws-gateway"]` e a flag andarem **juntos**: subir o container
sem virar o proxy é justamente o estado perigoso. `deploy/install.sh` e
`switch.sh --install` sobem o stack sem o profile, de propósito.

### O gate `WS_DISPATCH` fecha a janela que o `profiles` não fecha

O `profiles:` segura o `up` do dia a dia e só isso. Ele **não** fecha a janela
perigosa: subir o container para preparar a virada já o faz disputar o lock com
o Node, e é justamente aí que ele parece inofensivo (ninguém conectado nele).
Quem fecha essa janela é o gate `WS_DISPATCH`
(`ws-gateway/internal/outbox/gate.go`), **dentro do processo**: desligado
(default-deny — só `1`/`true`/`yes`/`on` ligam), o dispatcher do gateway não
existe; `PollOnce` também sai antes de abrir transação, e o `Run` registra no
log por que está inativo. Por isso profile e gate andam juntos: o profile é a
convenção de inicialização, o gate é a garantia.

As duas metades erradas são as duas falhas silenciosas que o `./switch.sh
--status` existe para fechar, cruzando gate × upstream × container:

| estado | o que acontece |
|---|---|
| proxy no gateway + gate desligado | os clientes conectam, assinam as rooms e **nenhum evento chega** |
| gate ligado + proxy ainda no Node | o gateway disputa o lock e engole cerca de metade dos eventos de quem está conectado lá |
| os três batendo (proxy no gateway + gate ligado + container no ar) | é o "está tudo bem", e nenhum marcador aparece |

O `--status` lê o gate da **env do container em execução** (o que o processo
leu), e o `/health` do gateway corrobora: `outboxEnabled` é o gate lido no
processo (`s.health != nil && outbox.DispatchEnabled()`), não só "existe pool".
Medido com a imagem real: vazio → `false`, `1` → `true`, `sim` → `false`. O
fallback no `.env` responde outra pergunta — o que o **próximo** `up` vai
aplicar — e diverge do container quando o `.env` foi editado sem `up`.

### Ligar e desligar (o caminho curto)

Runbook: `deploy/README.md` §"Como ligar" / §"Como desligar". A ordem é: subir o
gateway (`docker compose --profile ws-gateway up -d --build ws-gateway`),
**ligar o gate** (`WS_DISPATCH=1` no `.env` + um `up` do gateway, porque a env
só entra no container no `up` dele), conferir o `/health` dele com
`outboxEnabled:true`, decidir no `.env` (`WS_BACKEND=go`) e, se quiser o
efeito imediato, pôr `PDV_WS_UPSTREAM=ws-gateway:8080` no ponteiro e rodar
`caddy-assemble.sh reload` — sem recriar o container do Caddy, que custaria os
1–3s de queda que o switch existe para evitar.

A diferença entre as duas é o prazo de validade: a **flag** é o que sobrevive a
deploy, a **linha do ponteiro** é o que vale na hora. E o `write_pointer` do
switch **descarta** essa linha de propósito (`switch.sh:434-438`, que reescreve
o arquivo inteiro) para um override de emergência não virar configuração
permanente em silêncio.

### Rollback do realtime não é `--rollback`

`./switch.sh --rollback` mexe só no par backend/frontend: o gateway não está na
rotação azul/verde e o `--rollback` não o toca. O rollback do realtime é
**quente** — remover a linha `PDV_WS_UPSTREAM` do ponteiro, voltar
`WS_BACKEND=node` e **desligar o `WS_DISPATCH`** no `.env`, e `caddy reload`.
O passo do gate não é opcional: com `WS_DISPATCH=1` deixado no `.env`, o
próximo `up --profile ws-gateway` sobe o gateway publicando com o proxy já no
Node. Comandos no README §"Como desligar".

### O que o switch faz com o gateway

- **Não** o reconstrói (o build do switch é `backend frontend`, `switch.sh:618`),
  **não** o recria e **não** o inclui no `wait_healthy` — só backend e frontend
  são esperados (`switch.sh:594-595,633`; as instâncias `-next` é que estão no
  profile `canary`, `switch.sh:152`). Então uma mudança só em `ws-gateway/` não
  entra no deploy sozinha; quando o gateway é quem serve o realtime, o switch
  avisa no fim, com o comando para publicar (`switch.sh:678-683`).
- `--status` mostra `realtime=<upstream efetivo>` na primeira linha, o
  container na tabela e a **linha de verito do gate** (`switch.sh:546-578`, com
  `gate_status_line`). O `live_ws_upstream` replica a ordem do
  `caddy-assemble.sh` de propósito: se as duas regras divergirem, o `--status`
  mente.
- A rota `/health` **pública** continua no backend (`Caddyfile:144-153`), e é
  por isso que nem o `switch.sh` nem o `probe-availability.sh` medem o gateway:
  uma falha do gateway não pode reprovar um deploy em que o backend está
  perfeitamente saudável.

### Dev e local

- **local** (`docker-compose.local.yml`): igual à produção, roda o mesmo
  `caddy-assemble.sh`, então `WS_BACKEND=go` funciona igual. É onde se testa um
  switch com o gateway no ar antes do VPS.
- **dev** (`docker-compose.dev.yml`): o Caddy **não** roda o
  `caddy-assemble.sh` (a config é montada direto do `Caddyfile.dev`), então
  `WS_BACKEND` **não** é traduzida lá — defina `PDV_WS_UPSTREAM` direto no
  `.env` e suba o gateway com `--profile ws-gateway`.

### O que este guia não cobre (e o gate fecha)

Duas coisas que valem registrar porque é fácil supor o contrário:

- **O `/health` do gateway não é portão de deploy.** O `/health` **público** é o
  do backend e é o único que reprova um switch; o do gateway é interno do
  container dele (healthcheck `wget`), e o `switch.sh` não o espera. Isso é
  proposital: uma falha do gateway não pode reprovar um deploy em que o backend
  está saudável.
- **O `profiles:` não é o que impede o gateway de comer evento.** Quem impede é o
  gate `WS_DISPATCH` (ver §"O gate `WS_DISPATCH` fecha a janela que o `profiles`
  não fecha"). Se algum dia alguém "simplificar" tirando o gate por causa do
  `profile`, o serviço volta a poder subir publicando com o proxy no Node.

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
>
> E o mesmo lock agora arbitra também entre o dispatcher do Node e o do gateway
> em Go, quando os dois estão de pé — mais um motivo para o serviço do gateway
> ficar atrás de `profiles` (ver §"Por que ele não sobe sozinho").

## Medições

Últimas medições no stack local: 4 switches, 861 requisições, 0 falhas, 100% de disponibilidade, maior gap 0,0s; WebSocket reconectando em 293ms.

## Backup

- `deploy/backup.sh` faz `pg_dump` sob demanda
- **Pendência**: agendar o cron e copiar as cópias pra fora do servidor
- `deploy/backup-fetch.sh` baixa o backup do servidor

## Seed de produção

- `deploy/install.sh` roda o seed de produção (sem dados fictícios) + load-menu
- O seed de produção cria apenas o usuário gerente inicial

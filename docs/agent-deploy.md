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
├── caddy-assemble.sh          # resolve o upstream ativo e valida antes de aplicar
├── switch.sh                  # deploy sem downtime (switch/install/rollback/status)
├── deploy-pedido-public.sh    # republica SÓ o app público (npm run deploy:pedido)
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
| `./switch.sh` | Deploy sem downtime (instância nova + `caddy reload`). Sobe também o app público (`pedidopublic`). **Não** mexe no `ws-gateway` |
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
- O app público (`pedidopublic`) passa pelo **mesmo** portão, com `GET /healthz`. Esse
  caminho só existe porque o `apps/pedido-public/nginx.conf` tem um `location = /healthz`:
  sem ele o healthcheck batia no `location /`, que faz `try_files → /index.html` e
  devolve **200 para qualquer caminho** — verde com o bundle ausente. Healthcheck que
  não pode falhar não é portão, é enfeite.

### O app público de pedidos entra no switch, sem par `-next`

`pedidopublic` é nginx de estático: sem banco, sem migration, sem estado, sem
WebSocket. Não ganha instância `-next` (não há o que drenar, e bundle velho é
menos grave que schema sem migration), mas **tem que existir** — a Caddyfile
faz `reverse_proxy pedidopublic:80` em três blocos.

O switch então: constrói no passo 1, sobe com `--no-deps` no passo 2 e espera
o healthcheck no passo 3. Regras que não podem quebrar:

- `--no-deps` é obrigatório: o serviço declara `depends_on: caddy`, e sem o
  `--no-deps` o compose recriaria o PROXY para trocar um nginx de estático
  (derrubando `caddy reload` e as conexões WS do salão por causa de um cardápio)
- O `COMPOSE` usado é perguntado antes: os stacks `local`/`dev`
  (`docker-compose.local.yml`, `docker-compose.dev.yml`) **não** declaram o
  serviço, e `compose build pedidopublic` lá morre com "no such service". É o
  `has_service` (via `config --services`), não um `|| true` — que esconderia
  um erro de verdade
- `--rollback` **não** mexe nele: sem par `-next` não há instância anterior
  preservada
- O gap dele **não** é zero (container único, o `up` o substitui) e a
  documentação diz isso em vez de vender o mesmo contrato do PDV

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

### `ROOT_DOMAIN` — variável de ambiente, sintaxe `{$...}`, e ela é do Caddyfile

Além do upstream, a Caddyfile tem **endereço** parametrizado: `app.{$ROOT_DOMAIN}`,
`api.{$ROOT_DOMAIN}` e o wildcard `*.{$ROOT_DOMAIN}` (o cardápio público por
subdomínio). Três regras, e cada uma delas já parou um deploy:

- **A sintaxe é `{$ROOT_DOMAIN}`, nunca `${ROOT_DOMAIN}`.** No Caddyfile o
  `${...}` é substituição de *argumento de placeholder* em diretiva, não env.
  O `caddy validate` (o portão do switch) morre com
  `subject does not qualify for certificate: 'app.'`.
- **Ela precisa chegar no container**: está no `environment` do serviço `caddy`
  no compose, com default. Sem isso, um `.env` do VPS escrito antes da variável
  existir reprova o deploy no portão — que é a mesma classe de falha do
  `${...}`, só adiada.
- **`ROOT_DOMAIN` ≠ `DOMAIN`.** `DOMAIN` é o apex legado (`labolabe.tech`, que a
  Caddyfile ainda serve em bloco próprio, no fim, com TLS on-demand) e
  `ROOT_DOMAIN` é a raiz dos três blocos parametrizados. Pôr `labolabe.tech`
  como `ROOT_DOMAIN` sai com `ambiguous site definition: *.labolabe.tech` —
  medido com `caddy validate`.
- `caddy validate` não resolve upstream, mas resolve endereço: domínio que não
  existe no DNS não passa, mesmo com o `on_demand_tls` ligado.

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

São duas as combinações erradas, e as duas são falhas silenciosas — o que o
`./switch.sh --status` existe para fechar, cruzando gate × upstream × container:

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

## Os dois portões que falhavam em silêncio

O sintoma é o mesmo nos dois casos, e é o pior tipo de falha de automação:
**tudo fica verde e nada acontece**. Merge entra, release publica, e a
produção não muda — sem run vermelho em lugar nenhum para dizer que falhou.

### Gate A — o título da PR é a mensagem do squash

O merge é **squash** (exigido pelo ruleset da `main`), e o GitHub usa o
**título da PR** como mensagem do commit. O job de commitlint do
`pr-checks.yml` valida os **commits da branch** — nunca o título. Um título
fora de Conventional Commits vira um commit que o `commit-analyzer` não
entende, e o resultado é merge sem tag.

**MEDIDO (PR #89):** o título `feat/printer` entrou na `main` como
`aaf4551`, com 31 arquivos e 5.586 linhas, e o log do Semantic Release
respondeu:

```
[semantic-release] › ℹ  The commit should not trigger a release
[semantic-release] › ℹ  Analysis of 1 commits complete: no release
```

O run do release ficou **verde**. O commitlint reprovou a mesma PR pelo mesmo
motivo (`⧗ input: printer` / `subject may not be empty`), mas não é gate de
merge — a PR entrou assim mesmo.

O job **`Validar título da PR (Conventional Commit)`** fecha isso. Ele falha
com mensagem que diz o que fazer, e **avisa** (sem falhar) nos casos em que o
título é Conventional Commit válido mas o `.releaserc.json` não publica tag
com ele.

**De onde sai a mensagem do squash, de verdade.** Não é sempre o título, e o
job descobre isso na API (`squash_merge_commit_title` /
`squash_merge_commit_message`, com padrão declarado no job):

| `squash_merge_commit_title` | 1 commit | 2+ commits |
|---|---|---|
| `PR_TITLE` | título da PR | título da PR |
| `COMMIT_OR_PR_TITLE` | mensagem do commit | título da PR |

O estado **medido** deste repositório é `COMMIT_OR_PR_TITLE` +
`COMMIT_MESSAGES`: com um commit só, quem vira commit é a mensagem dele (e o
commitlint a valida); com dois ou mais, é o título. O job imprime a
configuração que usou no log, na linha `[gate] config do squash: ...`.

> O `github.token` do evento `pull_request` **não enxerga** esses dois campos
> de configuração de merge — a API responde `null`. Por isso o job declara o
> padrão medido como fallback, e a API só serve para confirmar quando ela
> responde. Mudar a configuração de squash do repositório significa atualizar
> esse padrão no job.

**O `!` de breaking não publica major aqui.** Medido com o próprio
`commit-analyzer` do repo (mesmas `releaseRules` do `.releaserc.json`, mesmo
preset `conventionalcommits`): `feat(api)!: x` sai com `type=null` e
`release=undefined`. O preset não casa o `!` no `headerPattern`, então
**nenhuma** regra casa e nada é publicado. Major exige uma nota
`BREAKING CHANGE:` no **corpo do commit** — que o commitlint não mede.

**O freeze do auto-merge.** Editar o título **depois** de enfileirar o
auto-merge **não** muda o commit de squash: o GitHub congela a mensagem na
hora em que a PR entra na fila. Medido: auto-merge ligado às 22:43:09, título
editado depois, o squash saiu com o título **antigo** (`fix(printer): ...
(#90)`). A ordem correta é: cancelar o auto-merge → renomear o título →
reenfileirar. A mensagem de erro do job lembra disso quando a PR já está na
fila.

**Para virar barreira de verdade:** hoje o ruleset da `main` só exige
`tests / test-backend` e `tests / test-frontend`. O gate do título roda e
aparece na aba de checks, mas **não bloqueia o merge** até alguém adicioná-lo
aos *required status checks* do ruleset. Mesmo para o `chore`: o aviso é
visível, não bloqueante.

### Gate B — tag publicada, produção parada

O `release.yml` só acorda o `deploy-on-tag.yml` se publicar a tag com um
**PAT** (`SEMANTIC_RELEASE_TOKEN`). O GitHub tem uma trava anti-recursão:
**evento criado com `GITHUB_TOKEN` não dispara workflow**. Sem o PAT, o
release cai no fallback, publica tag e release do mesmo jeito — e só o deploy
não sai.

**MEDIDO neste repositório, duas vezes:**

| Tags | Runs do `deploy-on-tag.yml` | Resultado |
|---|---|---|
| `v1.25.0`, `v1.25.1`, `v1.25.2` | **zero** | produção parada ~20h |
| `v1.26.0`, `v1.26.1` | **zero** | continuam sem deploy |

O secret **não existe**: `gh secret list` mostra `HOSTINGER_*`,
`TAURI_SIGNING_*` e `UPDATE_BASE_URL`, e nenhum `SEMANTIC_RELEASE_TOKEN`.

**`.github/workflows/auditoria-deploy.yml`** é a detecção: diário
(`schedule`) e na mão (`workflow_dispatch`). Ele pergunta se a tag de backend
mais recente tem run de deploy **concluído com sucesso**:

- **sem run nenhum** → falha, com o comando do PAT e o caminho de escape;
- **run em `queued`/`in_progress`** → aviso e saída 0 (auditoria que acusa
  deploy em andamento é falso positivo);
- **runs que acabaram sem sucesso** → falha apontando o run, porque aí o
  defeito é do deploy (healthcheck, migration, SSH), não da tag;
- **repositório sem tag nenhuma** → aviso e saída 0.

Só detecção, de propósito: um workflow que "conserta" o deploy por conta
própria esconderia o defeito atrás de um verde. A chave da linha de tag
(`--match 'v*.*.*' --exclude 'v1.4.*'`) é a **mesma** do job `tag-info` do
`deploy-on-tag.yml`, copiada — e é ela que já exclui a linha `app-v` do
instalador.

Rodar na mão (para auditar uma tag específica):

```bash
gh workflow run auditoria-deploy.yml                    # a mais recente
gh workflow run auditoria-deploy.yml -f tag=v1.25.3     # diagnóstico
```

> O `gh workflow run` só funciona **depois** que o arquivo está na branch
> padrão — o GitHub não faz dispatch de workflow que não existe na `main`.

### O conserto que só o dono do repo pode fazer

Um segredo não pode ser criado de dentro de uma PR. Na mão do dono:

```bash
gh secret set SEMANTIC_RELEASE_TOKEN --repo <owner>/<repo>
```

O PAT é **fine-grained**, escopo **`contents: write`**, **só neste
repositório**, expiração longa. Criar em GitHub → Settings → Developer
settings → Personal access tokens → Fine-grained. O release precisa escrever
a tag, criar a release e aplicar o label `released`.

**Por que o `||` do `release.yml` é intencional e não deve virar string
vazia pura:** sem o PAT, `secrets.SEMANTIC_RELEASE_TOKEN` resolve para
string vazia e o fallback entrega o `GITHUB_TOKEN` — o versionamento
automático continua funcionando, e só o deploy não dispara. Se a linha
virar só `secrets.SEMANTIC_RELEASE_TOKEN`, o primeiro `feat` mergeado depois
quebra o job por token ausente e o repo **perde o versionamento inteiro**,
por causa de um secret que ninguém criou. Degradar é aceitável; parar de
vez, não.

**O bloco `permissions:` do `release.yml` não resolve e não deve ser
mexido por causa disso:** ele dá escrita ao `GITHUB_TOKEN`, e a trava
anti-recursão vale para qualquer evento criado com esse token, qualquer que
seja o escopo. O PAT troca só a env do step.

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

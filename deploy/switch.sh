#!/bin/bash
# ============================================================
# switch.sh — deploy sem downtime
# ============================================================
# O que ele faz, e por que o downtime é zero:
#
#   1. build da imagem nova ......... nada em produção é tocado
#   2. sobe a instância "-next" ..... o tráfego continua na atual
#   3. espera o healthcheck ......... /health só abre DEPOIS das migrations
#                                   (server.ts: runMigrations() antes do
#                                    app.listen). Instância doente = aborta
#                                    aqui, com o proxy velho no ar.
#   4. grava o ponteiro e recarrega o Caddy (reload, não recreate): o
#      proxy passa a mandar tráfego para a instância nova. Quem já estava
#      com WebSocket aberto continua na antiga — o `stream_close_delay`
#      da Caddyfile impede que o reload derrube essas conexões.
#   5. para a instância antiga ....... SIGTERM drena as requisições em voo
#      (app.close()) e os WebSockets dela caem; o app reconecta em ~250ms
#      e recarrega o estado por REST (useRealtime -> onReconnect).
#
# Em nenhum momento existe um instante em que o Caddy aponte para algo
# que não está respondendo — por isso o gap de HTTP é 0, e não "quase 0".
#
# ---------- Onde mora o proxy (Caddy) ----------
# Em produção o Caddy NÃO é mais um container: ele roda no host, como unit
# systemd `pdv-caddy` (instalado/migrado pelo `caddy-host.sh`), e resolve os
# upstreams pelo /etc/hosts do host (`172.18.0.241 backend`, … — IPs fixos no
# docker-compose.yml). Os stacks locais (`--profile local`) continuam com o
# container, e é o próprio compose que diz qual dos dois mundos está valendo:
# `has_service caddy` = falso ⇒ proxy no host.
#
# O fluxo do switch é o MESMO nos dois — a única diferença é o endereço do
# reload no passo 4: `systemctl reload pdv-caddy` (host) ou
# `docker exec caddy …` (container). Nos dois lados roda o mesmo
# `caddy-assemble.sh` sobre o mesmo ponteiro `state/active-upstream`, com os
# mesmos `stream_close_delay`/health gates; quem escreve o ponteiro não muda.
# O reload do host exige root (ver `reload_caddy`), e `--status` mostra de
# qual dos dois mundos ele está falando.
#
# ---------- O que este script NÃO troca: o gateway WebSocket em Go ----------
# (e, pelo mesmo motivo, o app público de pedidos — ver a seção seguinte)
# O `ws-gateway` não entra no rodízio azul/verde, e a decisão é deliberada.
# Ele é stateless de verdade: não roda migration, não tem volume, não tem
# estado em disco — o que o switch sabe drenar (uma instância "-next" que
# só entra no proxy depois do healthcheck) não existe aqui. Um par
# `ws-gateway`/`ws-gateway-next` só duplicaria peça mobile, sem zerar
# downtime nenhum: recriar o container derruba as conexões abertas do mesmo
# jeito que o `stream_close_delay` segura as do backend.
#
# Consequência: o switch NÃO reconstrói a imagem do gateway (que vem no
# `compose build backend frontend`), então uma mudança só em `ws-gateway/`
# não entra no deploy sozinha. Quando o gateway é quem serve o /realtime, o
# switch avisa isso no fim, com o comando para publicar a mudança.
#
# ---------- O que este script SÓ LÊ: o gate de posse do realtime ----------
# `WS_DISPATCH` (`ws-gateway/internal/outbox/gate.go`) decide se o gateway
# pode publicar `outbox_event`. Ele também não entra na rotação: o dono do
# `/realtime` é uma decisão de UM passo, tomada junto com o proxy — não
# alguma coisa que troca a cada deploy. O switch nunca escreve nela.
#
# Ele LÊ porque o `/health` que os operadores apertam é o do BACKEND (o Caddy
# roteia `/health` para `PDV_BACKEND_UPSTREAM`, então nem o
# `probe-availability.sh` nem o switch medem o gateway), e o serviço do gateway
# não passa pelo `wait_healthy` (que cobre backend e frontend). Sem esta leitura
# o operador está às cegas nos dois estados silenciosos: proxy no gateway com o
# gate desligado (as conexões entram e nenhum evento chega) e gate ligado com o
# proxy ainda no Node (o gateway engole evento de quem está conectado lá).
#
# O `/health` DO gateway não substitui esta leitura — corrobora. O campo
# `outboxEnabled` dele responde se o gate está ligado no PROCESSO em execução
# (`s.health != nil && outbox.DispatchEnabled()` no cmd/gateway), e o processo
# leu a env do container: quando o container existe, as duas fontes dizem a mesma
# coisa por construção. Já o fallback no `.env` responde a uma pergunta
# DIFERENTE — o que o PRÓXIMO `up` vai aplicar. As duas divergem quando o `.env`
# foi editado sem `up`, que é o caso comum depois de uma edição no editor de
# texto, e é por isso que ele vem por último na ordem de `gate_env_value`.
#
# ---------- O que este script passou a fazer a mais: o app público ----------
# `pedidopublic` (apps/pedido-public, o cardápio/pedido do cliente final) é
# um nginx de arquivos estáticos — sem banco, sem migration, sem estado, sem
# WebSocket. Ele NÃO ganha uma instância "-next": o que ele serve é um bundle
# estático, e o modo de falha de "bundle velho no ar" é muito menos grave que
# o do backend (schema sem migration). O que ele PRECISA é existir, porque a
# Caddyfile faz `reverse_proxy pedidopublic:80` em dois blocos (`umamisushiarte.com.br`
# e o wildcard `*.ROOT_DOMAIN`; o `www` só redireciona) — sem container, 502 no ar.
#
# Então o switch o carrega dentro dos MESMOS passos, sem sair da semântica:
#   passo 1 — `compose build backend frontend pedidopublic`: a imagem entra
#     junto. Sem isto a Caddyfile continua apontando para `pedidopublic:80`
#     com o bundle da versão anterior — ou, na primeira vez, sem container
#     nenhum;
#   passo 2 — `compose up -d --no-deps ... pedidopublic`: `--no-deps` é a
#     regra do passo, nada aqui pode recriar o postgres nem o proxy (no
#     compose da produção o Caddy nem é serviço mais — é o unit do host; no
#     stack local, recriar o container do caddy derrubaria os WebSocket do
#     salão por causa de um cardápio);
#   passo 3 — `wait_healthy pedidopublic`: o MESMO portão dos outros dois, e
#     aqui ele finalmente significa alguma coisa — o `/healthz` passou a ser
#     servido de verdade pelo nginx (antes o healthcheck batia no
#     `try_files`, que devolve 200 para qualquer caminho). Instância doente =
#     aborta antes do reload, com o proxy velho no ar;
#   passo 5 — NÃO entra no rodízio: não há `pedidopublic-next`, então não há
#     o que parar. O container novo REVELA o antigo (é o `up` que faz a
#     troca), e como é conteúdo estático não há requisição em voo nem sessão
#     a drenar.
#
# Consequência assumida: entre o `up` e o fim do healthcheck (segundos) o
# cardápio público responde com o container novo já subindo. É uma janela
# curta e sobre conteúdo estático — não é o mesmo contrato do PDV, e fingir
# que é seria pior do que dizer isto aqui.
#
# O `--rollback` NÃO mexe no `pedidopublic`: sem par "-next" não há instância
# anterior preservada para voltar (mesma razão do `ws-gateway`). Um rollback
# do PDV deixa o cardápio público na versão do deploy que o switch promotes —
# para voltar atrás dele também é preciso um `./switch.sh` no commit antigo.
#
# Uso:
#   ./switch.sh                  # switch (o que o CI chama)
#   ./switch.sh --profile local  # mesmo switch no stack local (~/umami-utils/docker-up.sh)
#   ./switch.sh --rollback       # volta para a instância anterior
#   ./switch.sh --status         # quem está no ar agora
#   ./switch.sh --install        # primeira instalação (sobe do zero)
#   ./switch.sh --no-build       # não rebuilida a imagem (reaproveita a tag)
#
# Variáveis de ambiente:
#   PDV_DRAIN_SECONDS  espera entre o reload e a parada da antiga (padrão 5)
#   PDV_HEALTH_TIMEOUT segundos de espera pelo healthcheck (padrão 120)
#   PDV_PROBE_URL      URL usada pelo probe de disponibilidade (vazio = não
#                      verifica; o CI passa a URL pública)
#   PDV_COMPOSE_OVERRIDE  arquivos `-f` extras (stack de teste isolado)
#   COMPOSE_PROJECT_NAME  nome do projeto compose (padrão do compose)
# ============================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PROFILE="prod"      # prod | local  (escolhe o compose)
DRAIN_SECONDS="${PDV_DRAIN_SECONDS:-5}"
HEALTH_TIMEOUT="${PDV_HEALTH_TIMEOUT:-120}"
PROBE_URL="${PDV_PROBE_URL:-}"
NO_BUILD=0
ACTION="switch"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:?--profile exige local|prod}"
      shift 2
      ;;
    --rollback | --install | --status | --switch)
      ACTION="${1#--}"
      shift
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    -h | --help)
      # O intervalo acompanha o cabeçalho: se ele crescer, o `--help` passa
      # a cortar a ajuda no meio (ou a vazar código). Com `2,71` o `--help` já
      # perdia as seções "Uso" e "Variáveis de ambiente", que é justamente o
      # corte no meio. Regra: o primeiro número é 2, o segundo é a linha do
      # ÚLTIMO `#` do cabeçalho, uma antes do `set -euo pipefail` — que hoje
      # está na linha 133, então o cabeçalho fecha na 132.
      sed -n '2,132p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "argumento desconhecido: $1" >&2
      exit 2
      ;;
  esac
done

case "$PROFILE" in
  prod) COMPOSE_FILE="docker-compose.yml" ;;
  local) COMPOSE_FILE="docker-compose.local.yml" ;;
  *)
    echo "profile inválido: $PROFILE (use prod ou local)" >&2
    exit 2
    ;;
esac

COMPOSE=(docker compose -f "$COMPOSE_FILE")
# Mesmo compose escrito como texto, para as mensagens de operação: o
# gateway em Go sai do rodízio e o switch manda o comando pronto para o
# operador rodar (ver o fim de do_switch). Sem `--profile canary`, que é
# das instâncias "-next" e não tem relação com o gateway.
COMPOSE_CMD="docker compose -f ${COMPOSE_FILE}"
# `--profile ws-gateway` é o que faz o container do gateway existir.
COMPOSE_CMD="$COMPOSE_CMD --profile ws-gateway"
# `--profile pagarme-webhook` é o que faz o container do webhook existir.
COMPOSE_CMD="$COMPOSE_CMD --profile pagarme-webhook"
# A instalação não sobe as instâncias "-next" (elas só existem durante um
# switch), então ela usa a compose sem o profile.
COMPOSE_BASE=("${COMPOSE[@]}")
COMPOSE+=(--profile canary)
STATE_DIR="state"
STATE_FILE="$STATE_DIR/active-upstream"
# Onde o CI (job build-desktop) publica o instalador e o latest.json, por
# SSH. O proxy serve este diretório em /srv/pdv-updates: no host é o symlink
# que o `caddy-host.sh` cria (→ <deploy>/updates), no stack local é o bind
# mount do container.
UPDATES_DIR="updates"

# Os dois nomes possíveis, e o papel de cada um. "live" é quem o Caddy está
# apontando; "next" é o par que o switch vai promover.
BACKEND_SERVICES=(backend backend-next)
FRONTEND_SERVICES=(frontend frontend-next)

# O app público de pedidos entra no switch junto com o backend e o frontend
# (ver a seção do cabeçalho). O nome fica numa variável — e não espalhado em
# três comandos — porque o serviço NÃO existe em todo compose deste repositório:
# `docker-compose.local.yml` e `docker-compose.dev.yml` (os stacks de
# `--profile local`) não o declaram, e um `compose build pedidopublic` lá
# morre com "no such service". `has_service` é o que decide, uma vez, em vez de
# o switch inteiro carregar `|| true` que esconderia um erro de verdade.
PEDIDO_SERVICE="pedidopublic"

# Um serviço existe neste compose? Pergunta ao próprio compose (`config
# --services` é o mesmo caminho que o `config` do Passo A/F valida), e não a um
# grep no YAML: o YAML mente quando há `extends`, `profiles` ou override.
has_service() {
  "${COMPOSE[@]}" config --services 2>/dev/null | grep -qx "$1"
}

# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------
say() { printf '\n\033[1m[switch] %s\033[0m\n' "$*"; }
info() { printf '[switch] %s\n' "$*"; }
warn() { printf '[switch] AVISO: %s\n' "$*" >&2; }
fail() {
  printf '\n[switch] ERRO: %s\n' "$*" >&2
  exit 1
}

# Arquivos extras (o override do stack de teste local, por exemplo) e nome
# de projeto: `COMPOSE_PROJECT_NAME` é a variável padrão do próprio compose,
# então quem precisar de um stack isolado na mesma máquina só a exporta.
if [ -n "${PDV_COMPOSE_OVERRIDE:-}" ]; then
  # shellcheck disable=SC2086
  set -- $PDV_COMPOSE_OVERRIDE
  for f in "$@"; do
    [ -f "$f" ] || fail "override inexistente: $f"
    COMPOSE+=(-f "$f")
    COMPOSE_CMD="$COMPOSE_CMD -f $f"
  done
  unset f
fi

require_tools() {
  command -v docker >/dev/null 2>&1 || fail "docker não encontrado"
  docker compose version >/dev/null 2>&1 || fail "docker compose indisponível"
}

# Nome do serviço do par que está no ar agora, lido do ponteiro. Sem
# ponteiro = instalação nova = o par canônico.
live_backend() {
  local name="backend"
  [ -r "$STATE_FILE" ] || {
    echo "$name"
    return
  }
  local value
  value="$(grep -E '^PDV_BACKEND_UPSTREAM=' "$STATE_FILE" | head -1 | cut -d= -f2- || true)"
  case "$value" in
    backend-next:*) name="backend-next" ;;
  esac
  echo "$name"
}

live_frontend() {
  local name="frontend"
  [ -r "$STATE_FILE" ] || {
    echo "$name"
    return
  }
  local value
  value="$(grep -E '^PDV_FRONTEND_UPSTREAM=' "$STATE_FILE" | head -1 | cut -d= -f2- || true)"
  case "$value" in
    frontend-next:*) name="frontend-next" ;;
  esac
  echo "$name"
}

# Upstream efetivo do /realtime*, espelhando a resolução do
# caddy-assemble.sh (ponteiro > flag WS_BACKEND > seguir o backend). Aqui
# é só para o --status e o aviso do switch mostrarem a verdade; se as duas
# regras divergirem, o --status mente — daí o comentário, e a ordem ser
# idêntica. A flag vem do ambiente do PROXY: no stack local é o container do
# Caddy (é de lá que o caddy-assemble.sh lê); no host não há container, e o
# assemble lê o `.env` — a mesma fonte que este fallback passa a ler quando
# não há container, para os dois mundos responderem a mesma coisa.
live_ws_upstream() {
  local value=""
  if [ -r "$STATE_FILE" ]; then
    value="$(grep -E '^PDV_WS_UPSTREAM=' "$STATE_FILE" | head -1 | cut -d= -f2- || true)"
  fi
  if [ -n "$value" ]; then
    echo "$value"
    return
  fi
  local flag="" id
  id="$(svc_id caddy || true)"
  if [ -n "$id" ]; then
    flag="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null |
      sed -n 's/^WS_BACKEND=//p' | head -1 || true)"
  fi
  # Sem container do Caddy (produção: o proxy é o unit do host) a flag mora
  # no `.env`, que é exatamente de onde o caddy-assemble.sh do host a lê.
  # A remoção de ` #` e as aspas espelham o parser do próprio assemble —
  # os dois têm que devolver o mesmo veredito para o mesmo arquivo.
  if [ -z "$flag" ] && [ -r .env ]; then
    flag="$(grep -E '^[[:space:]]*WS_BACKEND=' .env | tail -1 | cut -d= -f2- || true)"
    flag="${flag%% #*}"
    flag="${flag#\"}"
    flag="${flag%%\"}"
    flag="${flag#\'}"
    flag="${flag%\'}"
    flag="$(printf '%s' "$flag" | tr -d '[:space:]')"
  fi
  if [ "$flag" = "go" ]; then
    echo "ws-gateway:8080"
    return
  fi
  if [ -r "$STATE_FILE" ]; then
    value="$(grep -E '^PDV_BACKEND_UPSTREAM=' "$STATE_FILE" | head -1 | cut -d= -f2- || true)"
    if [ -n "$value" ]; then
      echo "$value"
      return
    fi
  fi
  echo "backend:3000"
}

# ---------- o gate de posse do realtime (WS_DISPATCH) ----------
# O cabeçalho deste arquivo diz por que o switch LÊ essa variável e nunca a
# escreve: ela decide se o gateway pode publicar `outbox_event`, e o `--status`
# é o único lugar onde um operador descobre em que estado ela está — o `/health`
# que todo mundo aperta é o do BACKEND (`handle /health` no Caddyfile) e o
# `wait_healthy` do switch só cobre backend/frontend.
#
# O `/health` DO gateway não substitui esta leitura, mas a corrobora: o
# `outboxEnabled` dele é o gate lido no PROCESSO em execução
# (`s.health != nil && outbox.DispatchEnabled()` no cmd/gateway), e o processo
# leu a env do container. Medido contra a imagem real com Postgres de verdade:
# `WS_DISPATCH` vazio → `outboxEnabled:false`, `WS_DISPATCH=1` → `true`,
# `WS_DISPATCH=sim` → `false` (default-deny do gate.go). Dois lugares que
# discordam é o sinal de que um deles está olhando outro container, ou uma imagem
# construída antes do gate entrar no campo.
#
# De onde o valor vem, nesta ordem — e a ordem responde a duas perguntas
# diferentes, não a uma só:
#
#   1. o ambiente do CONTAINER do gateway — a verdade do que está RODANDO agora,
#      e é a mesma leitura que `live_ws_upstream` faz do `WS_BACKEND` do Caddy;
#   2. o ambiente DESTE shell — quem exportou a variável e rodou o status sem
#      refazer o `up` vê o que acabou de pedir;
#   3. o `.env` da pasta do deploy — é onde a decisão mora (ver .env.example)
#      e é o que o próximo `up` vai usar. Divergir da origem 1 é normal e
#      esperado aqui: editar o `.env` sem rodar `up` é o caminho de edição de
#      sempre, e essa é justamente a pergunta que o `outboxEnabled` do
#      `/health` não responde.
#
# Leitura pura: nada aqui cria container, muda estado ou exige stack no ar.
gate_env_value() {
  GATE_VALUE=""
  GATE_ORIGEM=""
  local value="" id
  # O container manda SEMPRE que existir, mesmo sem `WS_DISPATCH` dentro dele:
  # quem responde é o valor que o PROCESSO leu, e um container sem a variável é
  # justamente o modo de falha do .env.example (a linha falta no compose, o
  # `.env` diz 1 e o gateway segue mudo) — cair para o `.env` ali seria
  # mentir sobre o processo vivo. Sem container, aí sim, a decisão do `.env`
  # (e o ambiente deste shell, que o compose prefere) responde pelo próximo up.
  id="$(svc_id ws-gateway || true)"
  if [ -n "$id" ]; then
    value="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null |
      sed -n 's/^WS_DISPATCH=//p' | head -1 || true)"
    GATE_VALUE="$value"
    GATE_ORIGEM="container ws-gateway"
    return 0
  fi
  if [ -n "${WS_DISPATCH:-}" ]; then
    GATE_VALUE="$WS_DISPATCH"
    GATE_ORIGEM="ambiente"
    return 0
  fi
  [ -r .env ] || return 0
  # Espelha o parse do compose, que é quem decide o valor que entra no
  # container: aspas em volta saem e o que vem depois delas é comentário; sem
  # aspas, o comentário começa no primeiro ` #`. Sem essas duas regras, um
  # `WS_DISPATCH="1" # ligado na virada` — bem comum num `.env` comentado —
  # apareceria desligado aqui, e é esse o erro que a linha existe para não
  # dar: o valor errado aqui é justamente o que esconde o defeito real.
  value="$(grep -E '^[[:space:]]*WS_DISPATCH=' .env | tail -1 | cut -d= -f2- || true)"
  case "$value" in
    \"*)
      value="${value:1}"
      value="${value%%\"*}"
      ;;
    \'*)
      value="${value:1}"
      value="${value%%\'*}"
      ;;
    *) value="${value%% #*}" ;;
  esac
  # Aparar as pontas: o `grep | cut` deixa o espaço que precedia o comentário,
  # e o Go faz strings.TrimSpace antes do parse (gate.go).
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  GATE_VALUE="$value"
  GATE_ORIGEM=".env"
}

# Os mesmos quatro valores que ligam o gate (envTruthy em gate.go): 1, true,
# yes, on. Default-deny também aqui — `sim`, `0` e um valor mal digitado são
# desligados, porque é assim que o processo vai ler.
gate_truthy() {
  case "$(printf '%s' "$1" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
  esac
  return 1
}

# UMA linha de veredito sobre o gate, não dois campos neutros para o operador
# cruzar na cabeça: ele abriu o `--status` porque algo está errado. Os dois
# estados silenciosos só são diagnosticáveis cruzando gate × upstream ×
# container, e é esse cruzamento que a linha faz — `ws-gateway:*` no upstream
# com o dispatcher desligado (conexão entra, nenhum evento chega) e gate ligado
# com o proxy ainda no Node (o gateway engole evento de quem está conectado lá).
# Quando os três batem, nada de INCONSISTENTE aparece: a ausência do marcador
# é o "está tudo bem", que é o que se espera ler.
gate_status_line() {
  local ws_upstream="$1"
  local on_gateway=false gate_on=false gw_up=false
  local word porque marker="" valor
  gate_env_value
  valor="$GATE_VALUE"
  if gate_truthy "$valor"; then gate_on=true; fi
  if container_running ws-gateway; then gw_up=true; fi

  # A palavra vem do VERDICT do parse, não de o valor estar presente: um
  # `WS_DISPATCH=sim` está desligado (default-deny do gate.go) e dizer "ligado"
  # aqui seria o mesmo bug que o gate existe para impedir — só que na ferramenta
  # que o operador usa para checar o gate. O valor cru vai à parte, que é onde
  # o operador enxerga o que foi digitado de errado.
  if [ "$gate_on" = true ]; then
    word="LIGADO"
  else
    word="DESLIGADO"
  fi
  if [ -n "$valor" ]; then
    valor="WS_DISPATCH=$valor"
  else
    valor="WS_DISPATCH vazio"
  fi
  case "$ws_upstream" in
    ws-gateway:*) on_gateway=true ;;
  esac

  if [ "$on_gateway" = true ]; then
    if [ "$gw_up" != true ]; then
      marker="  [INCONSISTENTE]"
      porque="o /realtime aponta para o gateway e ele NÃO está no ar: todo handshake leva 502 (o app abre normal por REST e o realtime fica mudo)"
    elif [ "$gate_on" != true ]; then
      marker="  [INCONSISTENTE]"
      porque="o /realtime aponta para o gateway e o dispatcher está desligado: os clientes conectam, assinam as rooms e NENHUM evento chega, sem erro em log nenhum"
    else
      porque="o gateway é o dono do /realtime e o dispatcher está ligado: os eventos chegam"
    fi
  elif [ "$gate_on" = true ]; then
    marker="  [INCONSISTENTE]"
    if [ "$gw_up" != true ]; then
      porque="gate ligado, /realtime no Node e o gateway fora do ar: o próximo up --profile ws-gateway entra publicando com o proxy ainda no Node"
    else
      porque="gate ligado com o /realtime ainda no Node: o gateway disputa o advisory lock com o Node e engole cerca de metade dos eventos de quem está conectado lá (published=true sem ninguém ter recebido)"
    fi
  elif [ "$gw_up" = true ]; then
    porque="o /realtime está no Node e o dispatcher do gateway está desligado: o container no ar não publica nada (estado seguro antes da virada)"
  else
    porque="o /realtime está no Node e quem publica é o dispatcher dele (o gateway nem está no ar)"
  fi

  local origem="$GATE_ORIGEM"
  [ -n "$origem" ] || origem="não definida (nem ambiente nem .env)"
  printf 'gate do realtime: %s (%s; %s) — %s%s\n' "$word" "$valor" "$origem" "$porque" "$marker"
  if [ -n "$marker" ]; then
    # O comando de corroboração é de um mundo só: no stack local quem tem
    # wget e rota de rede é o container do caddy; no host ele não existe, e
    # a mesma leitura sai do próprio container do gateway (alpine/busybox
    # wget, imagem final do ws-gateway).
    local exemplo_wget
    if has_service caddy; then
      exemplo_wget="docker compose exec caddy wget -qO- http://ws-gateway:8080/health"
    else
      exemplo_wget="docker exec \$(docker compose ps -q ws-gateway) wget -qO- http://127.0.0.1:8080/health"
    fi
    printf '  o valor acima é a env do container em execução, e o /health do gateway a corrobora: outboxEnabled é o gate lido no processo (%s)\n' "$exemplo_wget"
    printf '  o .env não entra nesta conta de propósito: ele responde o que o PRÓXIMO up vai aplicar, não o que está rodando — as duas divergem quando alguém edita o .env sem rodar up\n'
  fi
}

other_of() {
  # other_of backend → backend-next
  case "$1" in
    backend) echo "backend-next" ;;
    backend-next) echo "backend" ;;
    frontend) echo "frontend-next" ;;
    frontend-next) echo "frontend" ;;
    *) fail "nome inesperado: $1" ;;
  esac
}

# Escreve o ponteiro preservando o inode do arquivo (o Caddy monta a config
# de dentro do container lendo este caminho). Sem arquivo temporário: o
# `state/` pode ter sido criado pelo Docker como root numa instalação
# antiga, e aí um `mktemp` ali dentro falha com "permissão negada".
write_pointer() {
  local backend_name="$1" frontend_name="$2"
  mkdir -p "$STATE_DIR"
  if ! { [ -w "$STATE_FILE" ] || { [ ! -e "$STATE_FILE" ] && [ -w "$STATE_DIR" ]; }; }; then
    fail "sem permissão para escrever $STATE_FILE.
   Se ele foi criado pelo Docker (bind mount) como root:
     sudo chown \"\$(id -u):\$(id -g)\" $STATE_DIR $STATE_FILE
   O arquivo é versionado no repo justamente para não depender disso."
  fi
  cat >"$STATE_FILE" <<EOF
# Gerado por switch.sh — qual instância está no ar. Lido pelo
# caddy-assemble.sh: no host pelo unit pdv-caddy, no stack local pelo
# container do Caddy. Não editar à mão.
PDV_BACKEND_UPSTREAM=${backend_name}:3000
PDV_FRONTEND_UPSTREAM=${frontend_name}:80
EOF
  # Uma linha PDV_WS_UPSTREAM escrito à mão (o botão de emergência do
  # realtime) é descartada aqui — este arquivo é reescrito inteiro. É de
  # propósito: a decisão sobre qual implementação serve o /realtime vive no
  # .env (WS_BACKEND), e o switch não deve carregar um override de mão por
  # cima dela no deploy seguinte, quando ninguém está olhando.
  info "ponteiro → $backend_name:3000 | $frontend_name:80"
}

# Id do container de um serviço (inclui os parados, que é o que o rollback
# precisa encontrar). O nome do container depende do nome do projeto, então
# nada aqui pode hardcodar "deploy-caddy-1".
svc_id() {
  "${COMPOSE[@]}" ps -q --all "$1" 2>/dev/null | head -1
}

svc_field() {
  local id
  id="$(svc_id "$1")"
  [ -n "$id" ] || return 1
  docker inspect -f "$2" "$id" 2>/dev/null
}

# Garante que o diretório de artefatos do auto-update exista E seja gravável
# pelo usuário do deploy. No stack local o bind mount do Caddy ainda cria o
# diretório como root (`./updates:/srv/pdv-updates:ro`) e o scp do job
# build-desktop — que roda com o usuário do CI — toma "permission denied",
# derrubando o job inteiro: o instalador não chega ao servidor e o cliente
# não tem o que baixar. No host o proxy lê pelo symlink que o caddy-host.sh
# cria, mas o dono do diretório continua sendo quem o CI escreve — mesma
# armadilha do `state/`, mesmo remedy.
ensure_updates_dir() {
  mkdir -p "$UPDATES_DIR" 2>/dev/null ||
    fail "não consegui criar $UPDATES_DIR (gravável pelo usuário atual?)."
  if [ ! -w "$UPDATES_DIR" ]; then
    fail "sem permissão de escrita em $UPDATES_DIR.
   Se o Docker o criou como root (bind mount ./updates), rode:
     sudo chown \"\$(id -u):\$(id -g)\" $UPDATES_DIR
   Sem isso o CI não consegue publicar o instalador por SSH."
  fi
  [ -e "$UPDATES_DIR/files/windows-x86_64" ] ||
    mkdir -p "$UPDATES_DIR/files/windows-x86_64"
  # Família standalone: um diretório por app. O Caddy espera latest.json em
  # deploy/updates/<app>/ e os artefatos em
  # deploy/updates/files/<app>/windows-x86_64/ (ver Caddyfile). Sem esses
  # diretórios, o scp do job build-desktop falha no primeiro deploy da família.
  for app in caixa kds; do
    [ -e "$UPDATES_DIR/$app" ] || mkdir -p "$UPDATES_DIR/$app"
    [ -e "$UPDATES_DIR/files/$app/windows-x86_64" ] ||
      mkdir -p "$UPDATES_DIR/files/$app/windows-x86_64"
  done
}

# O valor EFETIVO de ROOT_DOMAIN que o container do Caddy vai enxergar, lido
# do próprio compose (`config` já aplica o `${ROOT_DOMAIN:-default}` e o `.env`
# do host) em vez de do ambiente do container em execução.
#
# Por que essa leitura existe: variável de ambiente só entra no BOOT do
# container, e o switch troca a configuração por `caddy reload` (que é
# `docker exec`) justamente para não derrubar quem está com WebSocket aberto.
# Ou seja: o caminho quente do deploy é, por desenho, o caminho que NÃO pode
# pegar env nova. Medido no run 37412852257 (tag v1.29.1) — o `caddy validate`
# do passo 4/5 morreu com
#   subject does not qualify for certificate: 'app.'
# porque `app.{$ROOT_DOMAIN}` interpolou vazio: o container em pé foi criado
# antes da linha `ROOT_DOMAIN=` existir no compose, então nele a variável não
# existe — e o `docker exec` do reload não a injeta. O `compose config` deste
# lado, ao contrário, é lido a cada execução e enxerga o compose novo e o
# `.env` atual.
#
# Sai vazio de propósito quando o compose não declara a variável (o stack
# local usa `Caddyfile.local`, que não usa `{$ROOT_DOMAIN}`): aí não há o que
# injetar e o caddy-assemble.sh segue lendo só o que o container tem.
#
# `docker exec -e` não é recrear o container: o processo novo (o `caddy reload`)
# recebe a env, o proxy continua o MESMO processo — é o mesmo motivo pelo qual
# o `exec` já é o mecanismo do reload.
#
# Esta função só é chamada quando o compose AINDA declara o serviço caddy
# (stack local e a fase de migração): no modo host o `reload_caddy` nem chega
# aqui — quem lê ROOT_DOMAIN é o `.env`, via passo 0 do próprio
# caddy-assemble.sh, relido a cada `systemctl reload`.
caddy_root_domain() {
  "${COMPOSE[@]}" config 2>/dev/null | awk '
    /^  [a-zA-Z]/ { svc = $1 }
    svc == "caddy:" && /^    environment:/ { inenv = 1; next }
    inenv && /^    [a-zA-Z_]/ { inenv = 0 }
    inenv && /^      ROOT_DOMAIN:/ { sub(/^      ROOT_DOMAIN:[[:space:]]*/, ""); gsub(/^["'"'"']|["'"'"']$/, ""); print; exit }
  '
}

# Recarrega o proxy. A config é montada a partir do ponteiro acima
# (caddy-assemble.sh valida antes de aplicar) — nos DOIS mundos, com o mesmo
# script; o que muda é quem recebe o reload.
reload_caddy() {
  # ---------- Mundo host (produção): proxy é o unit pdv-caddy ----------
  # O compose da produção não tem o serviço `caddy`, então não há container
  # para `docker exec` — e não é um caso de "container sumiu", é o desenho
  # novo (ver cabeçalho, seção "Onde mora o proxy"). O unit invoca o MESMO
  # caddy-assemble.sh com PDV_CADDY_CONFIG/PDV_UPSTREAM_STATE/PDV_ENV_FILE
  # do deploy, então o ponteiro já escrito é aplicado igual; o `.env` é
  # relido a cada reload (diferente do `docker exec`, que fica com a env do
  # boot — é justamente o defeito que `caddy_root_domain` contorna no outro
  # caminho, e aqui não existe).
  if ! has_service caddy; then
    [ -f /etc/systemd/system/pdv-caddy.service ] ||
      fail "o compose desta versão não tem o serviço 'caddy' e o host não tem o unit pdv-caddy.
   Sem proxy nenhum neste estado — instale/migre primeiro:
     sudo bash deploy/caddy-host.sh"
    # Root obrigatório: `systemctl reload` para usuário comum exige regra de
    # polkit/sudoers que nenhum VPS traz de fábrica. O CI e o `--install`
    # costumam rodar como root; quando não rodam, o sudo sem senha resolve —
    # e se nem ele existir, o fail diz o que fazer em vez de morrer com
    # "Access denied" no meio do passo 4/5.
    if [ "$(id -u)" -eq 0 ]; then
      systemctl reload pdv-caddy ||
        fail "systemctl reload pdv-caddy falhou — veja: journalctl -u pdv-caddy -n 50"
    elif sudo -n true 2>/dev/null; then
      sudo -n systemctl reload pdv-caddy ||
        fail "systemctl reload pdv-caddy falhou — veja: journalctl -u pdv-caddy -n 50"
    else
      fail "o reload do proxy (unit pdv-caddy) precisa de root, e este shell não é root nem tem sudo sem senha.
   Rode o switch como root, ou libere só este comando para o usuário $(id -un):
     echo '$(id -un) ALL=(root) NOPASSWD: /usr/bin/systemctl reload pdv-caddy' | sudo tee /etc/sudoers.d/pdv-reload"
    fi
    return 0
  fi
  # ---------- Mundo container (stack local / fase de migração) ----------
  local id
  id="$(svc_id caddy)"
  [ -n "$id" ] || fail "container do caddy não encontrado (o stack está no ar?)"
  # Migração: até o primeiro deploy depois de o compose passar a montar o
  # diretório `deploy/`, o container em pé tem os mounts antigos e não tem
  # o script no caminho novo. Recriar o proxy é o único caminho nesses
  # casos — e custa alguns segundos de indisponibilidade, UMA vez. O
  # ponteiro já foi escrito antes daqui, então o container que sobe já
  # nasce apontando para a instância nova.
  if ! docker exec "$id" sh -c 'test -f /srv/pdv-deploy/caddy-assemble.sh' 2>/dev/null; then
    warn "container do caddy com mounts antigos — recriando (1x, após este deploy o switch passa a ser sem downtime)"
    "${COMPOSE[@]}" up -d --no-deps --force-recreate caddy >/dev/null
    return 0
  fi
  # A env do container é a do BOOT dele (ver `caddy_root_domain`): o reload é
  # `docker exec`, e exec não relê o compose nem o `.env`. Injetar o valor
  # efetivo lido do compose é o que faz o `caddy validate` do
  # caddy-assemble.sh interpolar o domínio certo mesmo em container criado
  # antes da linha `ROOT_DOMAIN=` existir — sem recriar o proxy, que é o
  # ponto do switch (1-3s de queda, WebSocket do salão junto).
  local -a env_caddy=()
  local root_domain no_container
  root_domain="$(caddy_root_domain || true)"
  if [ -n "$root_domain" ]; then
    env_caddy=(-e "ROOT_DOMAIN=$root_domain")
    # O aviso abaixo é o diagnóstico que o run 37412852257 não teve: um
    # container com env defasada é o estado que produz `app.` no Caddyfile, e
    # ele fica invisível enquanto o `docker exec` não comparar as duas fontes.
    no_container="$(svc_field caddy '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
      sed -n 's/^ROOT_DOMAIN=//p' | head -1 || true)"
    if [ "$no_container" != "$root_domain" ]; then
      warn "container do caddy com ROOT_DOMAIN defasado (container='${no_container:-vazio}', compose='${root_domain}') — o reload vai usar o valor do compose; um 'compose up -d caddy' alinha o container"
    fi
  fi
  # shellcheck disable=SC2086
  docker exec ${env_caddy[@]+"${env_caddy[@]}"} "$id" sh /srv/pdv-deploy/caddy-assemble.sh reload ||
    fail "caddy reload falhou — o proxy antigo continua no ar (ver: docker logs $id)"
}

wait_healthy() {
  local service="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) state
  info "aguardando healthcheck de ${service} (até ${HEALTH_TIMEOUT}s)…"
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(svc_field "$service" '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}' || echo ausente)"
    case "$state" in
      healthy)
        info "${service} está healthy"
        return 0
        ;;
      unhealthy)
        info "${service} ficou unhealthy — log do container:"
        "${COMPOSE[@]}" logs --tail=40 "$service" || true
        return 1
        ;;
      exited | dead)
        info "${service} parou (${state}) — log do container:"
        "${COMPOSE[@]}" logs --tail=40 "$service" || true
        return 1
        ;;
    esac
    sleep 2
  done
  fail "${service} não ficou healthy em ${HEALTH_TIMEOUT}s (estado atual: ${state:-desconhecido})"
}

container_running() {
  [ "$(svc_field "$1" '{{.State.Running}}' || echo false)" = "true" ]
}

# O rollback aponta para a instância que o switch PAROU — ela precisa existir
# (para o `start` ressuscitar), não estar rodando. Só a ausência é erro: aí
# não há imagem anterior para voltar.
container_exists() {
  [ -n "$(svc_id "$1")" ]
}

container_image() {
  svc_field "$1" '{{.Config.Image}}'
}

# Estado do proxy quando ele está fora do Docker (unit pdv-caddy no host).
# "não instalado" é um estado legítimo — o `--status` tem que responder em
# qualquer máquina (inclusive numa sem o host migrado) sem quebrar, e é o
# que o operador precisa fazer a seguir: rodar o caddy-host.sh.
proxy_status_systemd() {
  if [ ! -f /etc/systemd/system/pdv-caddy.service ]; then
    printf 'proxy (systemd pdv-caddy): não instalado (unit ausente — rode: sudo bash deploy/caddy-host.sh)\n'
    return 0
  fi
  local state
  if ! command -v systemctl >/dev/null 2>&1; then
    state="systemd indisponível neste ambiente"
  else
    # `is-active` sai != 0 para inactive/failed — o `|| true` é para o
    # set -e, não para esconder o estado: o texto (inactive, failed, …)
    # continua indo para a tela, que é onde ele explica o problema.
    state="$(systemctl is-active pdv-caddy 2>/dev/null || true)"
    [ -n "$state" ] || state="desconhecido"
  fi
  printf 'proxy (systemd pdv-caddy): %s\n' "$state"
}

do_status() {
  local be fe ws
  be="$(live_backend)"
  fe="$(live_frontend)"
  ws="$(live_ws_upstream)"
  if ! has_service caddy; then proxy_status_systemd; fi
  printf 'Caddy aponta para: backend=%s frontend=%s realtime=%s\n' "$be" "$fe" "$ws"
  gate_status_line "$ws"
  printf '\n%-16s %-22s %-12s %s\n' SERVIÇO IMAGEM ESTADO SAÚDE
  # O app público entra na lista: ele é destino de dois blocos da Caddyfile
  # (`umamisushiarte.com.br` e `*.ROOT_DOMAIN`; o `www` só redireciona), então
  # "não existe" ou "unhealthy" nele é 502 no ar — e o operador precisa ver
  # isso no `--status`, não descobrir pela tela do cliente.
  # O `caddy` só entra enquanto ele é serviço do compose (stack local/fase de
  # migração); no modo host a linha do proxy é a do systemd, acima — listar
  # "caddy … não existe" ali seria ruído, o container não é esperado.
  local -a status_servicos=(postgres)
  if has_service caddy; then status_servicos+=(caddy); fi
  status_servicos+=("${BACKEND_SERVICES[@]}" "${FRONTEND_SERVICES[@]}" ws-gateway)
  if has_service "$PEDIDO_SERVICE"; then status_servicos+=("$PEDIDO_SERVICE"); fi
  for svc in "${status_servicos[@]}"; do
    if [ -z "$(svc_id "$svc")" ]; then
      printf '%-16s %-22s %-12s %s\n' "$svc" "-" "-" "não existe"
      continue
    fi
    # Instância parada não tem "saúde": o healthcheck que sobrou no estado do
    # container é o da última execução e não quer dizer nada agora. Mostra o
    # estado do Docker (exited) para o `--rollback` ficar legível.
    local state health
    state="$(svc_field "$svc" '{{.State.Status}}' || echo '?')"
    if [ "$state" = "running" ]; then
      health="$(svc_field "$svc" '{{if .State.Health}}{{.State.Health.Status}}{{else}}—{{end}}' || echo '?')"
    else
      health="parado (disponível para --rollback)"
    fi
    printf '%-16s %-22s %-12s %s\n' "$svc" \
      "$(container_image "$svc" || echo '?')" \
      "$state" \
      "$health"
  done
  if [ -r "$STATE_FILE" ]; then
    printf '\nponteiro (%s):\n' "$STATE_FILE"
    sed 's/^/  /' "$STATE_FILE"
  fi
}

do_install() {
  say "primeira instalação — subindo o stack do zero"
  # Antes do `up`: o bind mount ./updates é o que cria o diretório como root
  # quando ele não existe, e aí o CI não consegue publicar o instalador.
  ensure_updates_dir
  # Proxy fora do Docker: prepara o host ANTES do `up`, e a ordem é o ponto.
  # O `up --remove-orphans` abaixo enxergaria o container do caddy antigo
  # como órfão (o serviço sumiu do compose) e o REMOVERIA enquanto ele ainda
  # serve tráfego — a janela seria a do build + healthcheck inteira. Com o
  # caddy-host.sh antes, a porta 80/443 já trocou de dono (container parado,
  # unit pdv-caddy no ar) e o `up` só limpa um container que não serve mais
  # ninguém. Em instalação de verdade não há container antigo, e o script é
  # idempotente. No stack local (`has_service caddy` true) não há o que
  # preparar: o proxy continua sendo o container de sempre.
  if ! has_service caddy; then
    say "proxy fora do Docker — preparando o host (caddy-host.sh)"
    if [ "$(id -u)" -eq 0 ]; then
      bash ./caddy-host.sh --deploy-dir "$PWD"
    elif command -v sudo >/dev/null 2>&1; then
      sudo bash ./caddy-host.sh --deploy-dir "$PWD"
    else
      fail "o caddy-host.sh precisa de root (unit em /etc/systemd/system) e este shell não é root nem tem sudo"
    fi
  fi
  info "o proxy sobe com a config sem ponteiro (defaults backend/frontend)"
  # --remove-orphans não remove as instâncias "-next": elas são serviços do
  # próprio compose (profile `canary`), não órfãos — medido, o `up` sem o
  # profile as deixa intactas. Sem isso, o ponteiro poderia ficar apontando
  # para um serviço que o comando apagou.
  "${COMPOSE_BASE[@]}" up -d --build --remove-orphans
  # Mesmo portão do switch, nos dois serviços: o /health só abre depois das
  # migrations, e o nginx precisa estar aceitando antes de o Caddy receber
  # tráfego.
  wait_healthy backend
  wait_healthy frontend
  # O `up` acima já sobe o app público (ele não está atrás de profile), mas
  # o portão é o mesmo dos outros dois: o Caddy tem dois blocos com
  # `reverse_proxy pedidopublic:80`, e um cardápio que não sobe é 502 no ar.
  if has_service "$PEDIDO_SERVICE"; then
    wait_healthy "$PEDIDO_SERVICE"
  fi
  say "instalado. Para os próximos deploys: ./switch.sh"
}

# ----------------------------------------------------------------------
# switch
# ----------------------------------------------------------------------
do_switch() {
  local old_be old_fe new_be new_fe
  # O app público entra na lista de containers deste switch (ver a seção do
  # cabeçalho). `HAS_PEDIDO` é resolvido UMA vez, antes de qualquer comando:
  # perguntar ao compose a cada passo seria o mesmo `config --services` três
  # vezes, e — pior — o resultado no meio do switch já poderia ter mudado.
  local tem_pedido=0
  if has_service "$PEDIDO_SERVICE"; then tem_pedido=1; fi

  old_be="$(live_backend)"
  old_fe="$(live_frontend)"
  new_be="$(other_of "$old_be")"
  new_fe="$(other_of "$old_fe")"

  require_tools
  say "switch: $old_be → $new_be (frontend $old_fe → $new_fe)"
  [ "$tem_pedido" = "1" ] || info "compose sem '$PEDIDO_SERVICE' (stack local) — o app público fica fora deste switch"
  ensure_updates_dir

  # --- 1. build (imagem compartilhada pelas duas instâncias) -----------
  # O app público entra no MESMO `build`: sem isso a Caddyfile continua
  # apontando para `pedidopublic:80` com o bundle da versão anterior — ou, na
  # primeira vez, sem container nenhum (502).
  local build_alvo=(backend frontend)
  if [ "$tem_pedido" = "1" ]; then build_alvo+=("$PEDIDO_SERVICE"); fi
  if [ "$NO_BUILD" = "1" ]; then
    info "--no-build: reaproveitando a tag $(docker images -q "${BACKEND_IMAGE:-pdv-backend:local}" | head -1)"
  else
    say "1/5 build da imagem nova (nada em produção é tocado)"
    "${COMPOSE[@]}" build "${build_alvo[@]}"
  fi

  # --- 2. sobe a próxima instância -------------------------------------
  say "2/5 subindo a instância nova (o tráfego segue na atual)"
  # --no-deps: o postgres já está no ar e não pode ser recriado aqui; o
  # healthcheck abaixo é o portão que substitui a dependência.
  local up_alvo=("$new_be" "$new_fe")
  if [ "$tem_pedido" = "1" ]; then up_alvo+=("$PEDIDO_SERVICE"); fi
  "${COMPOSE[@]}" up -d --no-deps "${up_alvo[@]}"

  # --- 3. healthcheck: o portão do corte -------------------------------
  # backend E frontend: o backend prova que as migrations terminaram (o
  # /health só responde depois delas); o frontend prova que o nginx já
  # atende. Sem o segundo, o reload podia apontar para um nginx que ainda
  # não subiu e o navegador levava 502 no primeiro F5.
  # O app público entra no MESMO portão: o `/healthz` do nginx dele é o que
  # impede que o passo 4 recarregue o proxy com dois blocos
  # `reverse_proxy pedidopublic:80` apontando para um cardápio que não sobe.
  say "3/5 aguardando a instância nova ficar healthy"
  if ! wait_healthy "$new_be" || ! wait_healthy "$new_fe"; then
    say "instância nova não ficou healthy — ABORTANDO sem tocar no proxy"
    info "o tráfego segue na instância antiga ($old_be); nada foi trocado"
    "${COMPOSE[@]}" stop "$new_be" "$new_fe" >/dev/null 2>&1 || true
    exit 1
  fi
  if [ "$tem_pedido" = "1" ] && ! wait_healthy "$PEDIDO_SERVICE"; then
    say "app público ($PEDIDO_SERVICE) não ficou healthy — ABORTANDO sem tocar no proxy"
    info "o PDV continua na instância antiga ($old_be); o cardápio público não foi promovido"
    info "log: ${COMPOSE_CMD} logs --tail=40 $PEDIDO_SERVICE"
    "${COMPOSE[@]}" stop "$new_be" "$new_fe" >/dev/null 2>&1 || true
    exit 1
  fi

  # --- 4. troca o upstream (reload gracioso) --------------------------
  say "4/5 apontando o proxy para a instância nova (caddy reload, sem derrubar WebSocket)"
  write_pointer "$new_be" "$new_fe"
  reload_caddy

  # Confere que o proxy responde pela instância nova antes de desligar a
  # antiga: se o reload não pegou, aborta com a antiga ainda de pé.
  if [ -n "$PROBE_URL" ]; then
    local ok=0
    for _ in $(seq 1 20); do
      if curl -fsS -m 2 "$PROBE_URL/health" >/dev/null 2>&1; then
        ok=1
        break
      fi
      sleep 0.5
    done
    if [ "$ok" != "1" ]; then
      say "proxy não respondeu após o reload — voltando o ponteiro"
      write_pointer "$old_be" "$old_fe"
      reload_caddy
      fail "abortado; o tráfego continua na instância antiga ($old_be)"
    fi
  fi

  # --- 5. drena e para a antiga ---------------------------------------
  say "5/5 parando a instância antiga (drain de ${DRAIN_SECONDS}s; o app reconecta e ressincroniza)"
  sleep "$DRAIN_SECONDS"
  "${COMPOSE[@]}" stop "$old_be" "$old_fe"

  say "switch concluído — no ar: $new_be / $new_fe"
  info "instância antiga preservada (container parado, mesma imagem) para --rollback"

  # ---------- O que este switch não fez ----------
  # O gateway em Go não entra no rodízio (decisão no cabeçalho), então não
  # foi reconstruído nem reiniciado aqui. Quando é ele quem serve o
  # /realtime, o operador precisa saber disso no MESMO log do deploy — senão
  # uma mudança só em `ws-gateway/` chega ao backend e nunca ao gateway, e
  # ninguém percebe até um comportamento estranho no salão.
  case "$(live_ws_upstream)" in
    ws-gateway:*)
      say "nota: o /realtime está no gateway Go, que este switch NÃO atualizou"
      info "para publicar mudança em ws-gateway/: ${COMPOSE_CMD} build ws-gateway && ${COMPOSE_CMD} up -d --no-deps ws-gateway"
      info "esse restart derruba as conexões WS abertas (o app reconecta pelo backoff e ressincroniza por REST)"
      ;;
  esac
}

# ----------------------------------------------------------------------
# rollback
# ----------------------------------------------------------------------
do_rollback() {
  require_tools
  ensure_updates_dir
  local cur_be cur_fe old_be old_fe
  cur_be="$(live_backend)"
  cur_fe="$(live_frontend)"
  old_be="$(other_of "$cur_be")"
  old_fe="$(other_of "$cur_fe")"

  if ! container_exists "$old_be"; then
    fail "não há instância anterior para voltar ($old_be não existe — instalação nova, ou o container foi removido)"
  fi

  say "rollback: $cur_be → $old_be"
  # `start`, nunca `up`: o container parado é o da imagem ANTERIOR, e é
  # justamente ele que o rollback precisa trazer de volta.
  "${COMPOSE[@]}" start "$old_be" "$old_fe" >/dev/null
  # O mesmo portão do switch: só aponta o proxy depois de a instância estar
  # de pé. Sem isto, voltar para uma instância que não sobe (ou que ficou
  # unhealthy de um switch abortado) trocaria um app que funciona por um
  # que não responde.
  if ! wait_healthy "$old_be" || ! wait_healthy "$old_fe"; then
    fail "rollback abortado: $old_be/$old_fe não ficaram healthy — o tráfego segue em $cur_be/$cur_fe"
  fi
  write_pointer "$old_be" "$old_fe"
  reload_caddy
  say "rollback concluído — no ar: $old_be / $old_fe"
  info "para voltar à versão nova, rode ./switch.sh"
}

case "$ACTION" in
  status) do_status ;;
  install) do_install ;;
  rollback) do_rollback ;;
  switch) do_switch ;;
esac

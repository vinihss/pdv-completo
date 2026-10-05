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
# ---------- O que este script NÃO troca: o gateway WebSocket em Go ----------
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
      # a cortar a ajuda no meio (ou a vazar código). Hoje o cabeçalho fecha
      # na linha 76 e o código começa na 77 — com `2,71` o `--help` já perdia
      # as seções "Uso" e "Variáveis de ambiente", que é justamente o corte no
      # meio. Regra: o primeiro número é 2, o segundo é a linha do último `#`
      # do cabeçalho, uma antes do `set -euo pipefail`.
      sed -n '2,76p' "$0" | sed 's/^# \{0,1\}//'
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
# `--profile ws-gateway` é o que faz o container do gateway existir.
COMPOSE_CMD="$COMPOSE_CMD --profile ws-gateway"
# A instalação não sobe as instâncias "-next" (elas só existem durante um
# switch), então ela usa a compose sem o profile.
COMPOSE_BASE=("${COMPOSE[@]}")
COMPOSE+=(--profile canary)
STATE_DIR="state"
STATE_FILE="$STATE_DIR/active-upstream"
# Onde o CI (job build-desktop) publica o instalador e o latest.json, por
# SSH. O compose monta este diretório em /srv/pdv-updates no Caddy.
UPDATES_DIR="updates"

# Os dois nomes possíveis, e o papel de cada um. "live" é quem o Caddy está
# apontando; "next" é o par que o switch vai promover.
BACKEND_SERVICES=(backend backend-next)
FRONTEND_SERVICES=(frontend frontend-next)

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
# idêntica. A flag vem do ambiente do container do Caddy porque é de lá que
# o caddy-assemble.sh lê (e é o único lugar onde ela existe depois do
# boot).
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
    printf '  o valor acima é a env do container em execução, e o /health do gateway a corrobora: outboxEnabled é o gate lido no processo (docker compose exec caddy wget -qO- http://ws-gateway:8080/health)\n'
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
  if ! { [ -w "$STATE_FILE" ] || [ ! -e "$STATE_FILE" -a -w "$STATE_DIR" ]; }; then
    fail "sem permissão para escrever $STATE_FILE.
   Se ele foi criado pelo Docker (bind mount) como root:
     sudo chown \"\$(id -u):\$(id -g)\" $STATE_DIR $STATE_FILE
   O arquivo é versionado no repo justamente para não depender disso."
  fi
  cat >"$STATE_FILE" <<EOF
# Gerado por switch.sh — qual instância está no ar. Lido pelo container do
# Caddy (caddy-assemble.sh). Não editar à mão.
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
# pelo usuário do deploy. Sem isso o bind mount do Caddy cria o diretório como
# root (`./updates:/srv/pdv-updates:ro`) e o scp do job build-desktop — que
# roda com o usuário do CI — toma "permission denied", derrubando o job
# inteiro: o instalador não chega ao servidor e o cliente não tem o que
# baixar. Mesma armadilha do `state/`, mesmo remedy.
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

# Recarrega o proxy. A config é montada DENTRO do container do Caddy a
# partir do ponteiro acima (caddy-assemble.sh valida antes de aplicar).
reload_caddy() {
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
  docker exec "$id" sh /srv/pdv-deploy/caddy-assemble.sh reload ||
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

do_status() {
  local be fe ws
  be="$(live_backend)"
  fe="$(live_frontend)"
  ws="$(live_ws_upstream)"
  printf 'Caddy aponta para: backend=%s frontend=%s realtime=%s\n' "$be" "$fe" "$ws"
  gate_status_line "$ws"
  printf '\n%-16s %-22s %-12s %s\n' SERVIÇO IMAGEM ESTADO SAÚDE
  for svc in postgres caddy "${BACKEND_SERVICES[@]}" "${FRONTEND_SERVICES[@]}" ws-gateway; do
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
  info "o Caddy sobe com a config montada no container, sem ponteiro (defaults backend/frontend)"
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
  say "instalado. Para os próximos deploys: ./switch.sh"
}

# ----------------------------------------------------------------------
# switch
# ----------------------------------------------------------------------
do_switch() {
  local old_be old_fe new_be new_fe
  old_be="$(live_backend)"
  old_fe="$(live_frontend)"
  new_be="$(other_of "$old_be")"
  new_fe="$(other_of "$old_fe")"

  require_tools
  say "switch: $old_be → $new_be (frontend $old_fe → $new_fe)"
  ensure_updates_dir

  # --- 1. build (imagem compartilhada pelas duas instâncias) -----------
  if [ "$NO_BUILD" = "1" ]; then
    info "--no-build: reaproveitando a tag $(docker images -q "${BACKEND_IMAGE:-pdv-backend:local}" | head -1)"
  else
    say "1/5 build da imagem nova (nada em produção é tocado)"
    "${COMPOSE[@]}" build backend frontend
  fi

  # --- 2. sobe a próxima instância -------------------------------------
  say "2/5 subindo a instância nova (o tráfego segue na atual)"
  # --no-deps: o postgres já está no ar e não pode ser recriado aqui; o
  # healthcheck abaixo é o portão que substitui a dependência.
  "${COMPOSE[@]}" up -d --no-deps "$new_be" "$new_fe"

  # --- 3. healthcheck: o portão do corte -------------------------------
  # backend E frontend: o backend prova que as migrations terminaram (o
  # /health só responde depois delas); o frontend prova que o nginx já
  # atende. Sem o segundo, o reload podia apontar para um nginx que ainda
  # não subiu e o navegador levava 502 no primeiro F5.
  say "3/5 aguardando a instância nova ficar healthy"
  if ! wait_healthy "$new_be" || ! wait_healthy "$new_fe"; then
    say "instância nova não ficou healthy — ABORTANDO sem tocar no proxy"
    info "o tráfego segue na instância antiga ($old_be); nada foi trocado"
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
    local ok=0 i
    for i in $(seq 1 20); do
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

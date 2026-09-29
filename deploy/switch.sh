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
# Uso:
#   ./switch.sh                  # switch (o que o CI chama)
#   ./switch.sh --profile local  # mesmo switch no stack local (docker-up.sh)
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
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
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
# Arquivos extras (o override do stack de teste local, por exemplo) e nome
# de projeto: `COMPOSE_PROJECT_NAME` é a variável padrão do próprio compose,
# então quem precisar de um stack isolado na mesma máquina só a exporta.
if [ -n "${PDV_COMPOSE_OVERRIDE:-}" ]; then
  # shellcheck disable=SC2086
  set -- $PDV_COMPOSE_OVERRIDE
  for f in "$@"; do
    [ -f "$f" ] || fail "override inexistente: $f"
    COMPOSE+=(-f "$f")
  done
  unset f
fi
# A instalação não sobe as instâncias "-next" (elas só existem durante um
# switch), então ela usa a compose sem o profile.
COMPOSE_BASE=("${COMPOSE[@]}")
COMPOSE+=(--profile canary)
STATE_DIR="state"
STATE_FILE="$STATE_DIR/active-upstream"

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
  local be fe
  be="$(live_backend)"
  fe="$(live_frontend)"
  printf 'Caddy aponta para: backend=%s frontend=%s\n' "$be" "$fe"
  printf '\n%-16s %-22s %-12s %s\n' SERVIÇO IMAGEM ESTADO SAÚDE
  for svc in postgres caddy "${BACKEND_SERVICES[@]}" "${FRONTEND_SERVICES[@]}"; do
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
}

# ----------------------------------------------------------------------
# rollback
# ----------------------------------------------------------------------
do_rollback() {
  require_tools
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

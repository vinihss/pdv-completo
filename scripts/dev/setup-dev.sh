#!/bin/bash
# ============================================================================
# Setup do ambiente de DEV do PDV — TUDO em containers Docker.
#
# Sobe o stack `pdv-dev` (docker compose: deploy/docker-compose.yml +
# deploy/docker-compose.override.yml) com os serviços postgres, redis,
# backend, frontend (Vite) e caddy. O host só precisa do Docker: nada de
# `npm install`, nada de `npm run dev`, nada de Postgres nativo.
#
# O código do backend e do frontend entra por bind mount — editar no host
# reflete no container (hot reload).
#
# Chamado por `pdv setup` (cmd/pdv/internal/commands/setup.go).
# ============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DEPLOY_DIR="$ROOT_DIR/deploy"
FRONTEND_DIR="$ROOT_DIR/frontend"
ENV_DEV="$DEPLOY_DIR/.env.dev"

# O comando exato do compose — o mesmo que o script usa e o mesmo que é
# impresso no resumo (para o usuário copiar e colar sem editar nada).
DC="docker compose --env-file deploy/.env.dev -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml"

PROJECT="pdv-dev"
SERVICES=(postgres redis backend frontend caddy)

# Container do Postgres que a versão ANTERIOR deste script subia com
# `docker run` (sem volume nomeado, na rede `pdv-internal` da produção).
LEGACY_PG_CONTAINER="pdv-dev-postgres"
# Log que a versão anterior escrevia — a assinatura que identifica o Vite
# que ela deixou no background.
LEGACY_VITE_LOG="/tmp/pdv-frontend.log"

DO_SEED=1

# -----------------------------------------------------------------
# Mensagens
# -----------------------------------------------------------------
pass() { echo "OK: $*"; }
warn() { echo "AVISO: $*" >&2; }
die()  { echo "ERRO: $*" >&2; exit 1; }

usage() {
    cat <<EOF
Uso: $(basename "$0") [opções]

  --no-seed      não roda o seed (preserva os dados do banco)
  -h, --help     esta ajuda

Sobe o ambiente de dev INTEIRO em containers Docker (docker compose):
postgres, redis, backend, frontend (Vite) e caddy. O host só precisa do
Docker — não precisa de Node.js nem de Postgres instalados.

Depois de subir:
  App (Vite)   http://localhost:5173   (caminho do HMR)
  API via app  http://localhost:5173/api/health
  Caddy (dev)  http://localhost:8081   (entrada alternativa do mesmo app)
  Login        e-mail + senha (ana.ribeiro@pdv.local / pdv1234)
                fallback por PIN na tela /login/pin
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-seed) DO_SEED=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Opção desconhecida: $1 (veja --help)" >&2; exit 2 ;;
    esac
done

# -----------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------
dc() {
    # shellcheck disable=SC2086 # DC é uma linha de comando Montada à mão
    $DC "$@"
}

# Lê uma chave do arquivo de env do dev (com default).
env_get() {
    local key="$1" default="${2:-}" val
    val="$(sed -n "s/^${key}=//p" "$ENV_DEV" 2>/dev/null | tail -1)"
    if [[ -n "$val" ]]; then echo "$val"; else echo "$default"; fi
}

# Grava/atualiza uma chave do arquivo de env do dev, preservando o resto.
env_set() {
    local key="$1" value="$2" tmp
    tmp="${ENV_DEV}.tmp.$$"
    if [[ -f "$ENV_DEV" ]] && grep -qE "^${key}=" "$ENV_DEV"; then
        awk -v k="$key" -v v="$value" '$0 ~ "^" k "=" { print k "=" v; next } { print }' \
            "$ENV_DEV" > "$tmp"
    else
        [[ -f "$ENV_DEV" ]] && cat "$ENV_DEV" > "$tmp"
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
    fi
    mv "$tmp" "$ENV_DEV"
    chmod 600 "$ENV_DEV"
}

# 32 bytes aleatórios em hex (JWT_SECRET do dev).
random_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    elif [[ -r /dev/urandom ]]; then
        od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
    else
        printf '%s' "$(date +%s)$${RANDOM}$$" | sha256sum | cut -c1-64
    fi
}

# A porta está livre no host?
port_is_free() {
    local p="$1"
    if command -v ss >/dev/null 2>&1; then
        if ss -ltnH "sport = :${p}" 2>/dev/null | grep -q .; then return 1; fi
    else
        if netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"; then return 1; fi
    fi
    return 0
}

# Quem está segurando a porta (para a mensagem de erro ser acionável).
port_holder() {
    local p="$1" holder pid
    holder="$(port_container "$p")"
    if [[ -n "$holder" ]]; then
        echo "container Docker '${holder}'"
        return
    fi
    pid="$(ss -ltnpH "sport = :${p}" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
    if [[ -n "$pid" ]]; then
        echo "processo do host (pid ${pid}: $(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | cut -c1-70))"
    else
        echo "processo do host (sem permissão para ver o pid — use 'sudo ss -ltnp')"
    fi
}

# Nome do container Docker que publica a porta (vazio se não for container).
port_container() {
    local p="$1"
    docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
        | awk -F'|' -v pat=":${p}->" '$2 ~ pat { print $1; exit }'
}

# O container é de um serviço do NOSSO stack de dev (projeto compose pdv-dev)?
is_own_service() {
    local name="$1" svc="$2" project service
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null || true)"
    service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$name" 2>/dev/null || true)"
    [[ "$project" == "$PROJECT" && "$service" == "$svc" ]]
}

# A porta está disponível PARA O NOSSO STACK? (ignora o container do próprio
# stack — numa segunda execução ele é quem está segurando a porta.)
port_free_for_us() {
    local p="$1" svc="$2" holder
    holder="$(port_container "$p")"
    if [[ -n "$holder" ]] && is_own_service "$holder" "$svc"; then
        return 0
    fi
    port_is_free "$p"
}

# Primeira porta livre a partir de $1.
pick_free_port() {
    local p="$1" i
    for ((i = 0; i < 100; i++)); do
        if port_is_free "$p"; then echo "$p"; return 0; fi
        p=$((p + 1))
    done
    return 1
}

# Estado do container de um serviço: healthy | unhealthy | running | exited | ausente
service_state() {
    local svc="$1" cid
    cid="$(dc ps -q --all "$svc" 2>/dev/null | head -1)"
    if [[ -z "$cid" ]]; then echo "ausente"; return; fi
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$cid" 2>/dev/null || echo "desconhecido"
}

# Espera o serviço chegar no estado desejado. Retorna 1 em timeout/exit.
wait_service() {
    local svc="$1" want="$2" timeout="${3:-180}" i st
    for ((i = 0; i < timeout; i++)); do
        st="$(service_state "$svc")"
        if [[ "$st" == "$want" ]]; then return 0; fi
        case "$st" in
            exited|dead) return 1 ;;
        esac
        sleep 1
    done
    return 1
}

# Status HTTP de uma URL ("000" = não respondeu).
http_code() {
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null)"
    [[ -n "$code" ]] && echo "$code" || echo "000"
}

# -----------------------------------------------------------------
# 0. Cabeçalho
# -----------------------------------------------------------------
echo "=== PDV Setup Dev (tudo em containers) ==="
echo ""

# -----------------------------------------------------------------
# 1. Pré-requisitos — Docker e curl. Node.js NÃO é necessário: o
#    backend e o frontend rodam dentro dos containers.
# -----------------------------------------------------------------
command -v docker >/dev/null || die "Docker não encontrado. Instale o Docker e tente novamente."
docker info >/dev/null 2>&1 || die "O daemon do Docker não está respondendo. Suba o Docker (systemctl start docker) e tente novamente."
command -v curl >/dev/null || die "curl não encontrado. Instale o curl e tente novamente."
if ! docker compose version >/dev/null 2>&1; then
    die "plugin 'docker compose' (v2) não encontrado. Instale a extensão docker-compose e tente novamente."
fi
pass "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
pass "docker compose $(docker compose version --short 2>/dev/null | head -1)"

# -----------------------------------------------------------------
# 2. Env do dev — deploy/.env.dev
#    O compose base lê `deploy/.env` (o arquivo de PRODUÇÃO) quando existe.
#    O dev usa --env-file para NÃO tocar nesse arquivo: o env do dev é
#    `deploy/.env.dev`, criado aqui e nunca versionado.
# -----------------------------------------------------------------
if [[ -f "$ENV_DEV" ]]; then
    pass "deploy/.env.dev já existe (preservado)"
else
    cat > "$ENV_DEV" <<EOF
# Env do stack de DEV (projeto compose '${PROJECT}').
# Gerado por scripts/dev/setup-dev.sh.
# NÃO é a config de produção (deploy/.env): este arquivo é só do dev.
DEPLOYMENT_MODE=local
POSTGRES_USER=pdv
POSTGRES_PASSWORD=pdv_password
POSTGRES_DB=pdv
JWT_SECRET=$(random_secret)
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
LOG_LEVEL=info
APP_TAG=dev
DEV_FRONTEND_PORT=5173
DEV_POSTGRES_PORT=5432
DEV_CADDY_HTTP_PORT=8081
EOF
    chmod 600 "$ENV_DEV"
    pass "deploy/.env.dev criado (JWT_SECRET aleatório de 32 bytes)"
fi

FRONTEND_PORT="$(env_get DEV_FRONTEND_PORT 5173)"
POSTGRES_PORT="$(env_get DEV_POSTGRES_PORT 5432)"
CADDY_HTTP_PORT="$(env_get DEV_CADDY_HTTP_PORT 8081)"

# -----------------------------------------------------------------
# 3. Limpeza do que a versão ANTERIOR deste script deixou
# -----------------------------------------------------------------
echo ""
echo "Verificando restos do setup anterior..."

# 3.1 O container `pdv-dev-postgres` (do `docker run` antigo). Ele segura a
#     porta 5432 e o `up` do compose falharia com "port is already
#     allocated". Os dados dele eram efêmeros (volume anônimo): o stack novo
#     usa o volume nomeado `pdv-dev_postgres_data_dev` e roda o seed de novo.
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$LEGACY_PG_CONTAINER"; then
    warn "removendo o container legado '${LEGACY_PG_CONTAINER}' (Postgres do script antigo; os dados eram efêmeros — o stack novo usa o volume nomeado 'pdv-dev_postgres_data_dev' e roda o seed de novo)"
    docker rm -f "$LEGACY_PG_CONTAINER" >/dev/null
    pass "container legado '${LEGACY_PG_CONTAINER}' removido"
else
    pass "nenhum container legado '${LEGACY_PG_CONTAINER}'"
fi

# 3.2 O Vite que o script antigo deixou rodando no host (npm run dev em
#     background, log em /tmp/pdv-frontend.log). Ele segura a porta 5173 —
#     a mesma que o container do frontend vai publicar. Só é morto o processo
#     que tem a assinatura do script antigo (cwd = frontend/ E stdout no log).
stop_legacy_vite() {
    local pid cwd out killed=0
    for pid in $(pgrep -f "node_modules/\.bin/vite" 2>/dev/null || true); do
        cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$FRONTEND_DIR" ]] || continue
        out="$(readlink "/proc/${pid}/fd/1" 2>/dev/null || true)"
        [[ "$out" == "$LEGACY_VITE_LOG" ]] || continue
        warn "parando o Vite que o script anterior deixou no host (pid ${pid}, log ${LEGACY_VITE_LOG}) — agora o app é servido pelo container"
        kill "$pid" 2>/dev/null || true
        killed=1
    done
    [[ "$killed" -eq 1 ]] && sleep 2
    return 0
}
stop_legacy_vite

# -----------------------------------------------------------------
# 4. Portas
#    Nenhuma porta é exigência dura: o host pode já ter o Postgres
#    nativo na 5432, o Caddy de produção em 80/443/8081 etc. Quando a
#    porta configurada está ocupada por coisa de FORA do stack, o
#    script migra para a próxima livre (5432 -> 5433 -> ...), avisa
#    quem estava segurando e GRAVA a escolha em `deploy/.env.dev` —
#    assim a segunda execução começa de onde a anterior parou, em
#    vez de pular de porta em porta.
#
#    A checagem ignora o container do NOSSO stack (`port_free_for_us`):
#    numa segunda execução é ele que está segurando a porta.
#
#    O Postgres é o caso especial: a porta publicada é só para o host
#    falar com o banco (psql/DBeaver). O `DATABASE_URL` do backend é
#    INTERNO (`postgres:5432` na rede do projeto) e não muda com ela.
# -----------------------------------------------------------------
echo ""
if ! port_free_for_us "$POSTGRES_PORT" postgres; then
    NEW_PORT="$(pick_free_port "$POSTGRES_PORT")" || die "não achei porta livre para o Postgres (a partir de ${POSTGRES_PORT})"
    warn "a porta ${POSTGRES_PORT} está ocupada por $(port_holder "$POSTGRES_PORT") — o Postgres do dev foi publicado em ${NEW_PORT}"
    POSTGRES_PORT="$NEW_PORT"
    env_set DEV_POSTGRES_PORT "$POSTGRES_PORT"
else
    pass "porta ${POSTGRES_PORT} livre (Postgres do dev)"
fi

if ! port_free_for_us "$FRONTEND_PORT" frontend; then
    NEW_PORT="$(pick_free_port "$FRONTEND_PORT")" || die "não achei porta livre para o frontend (a partir de ${FRONTEND_PORT})"
    warn "a porta ${FRONTEND_PORT} está ocupada por $(port_holder "$FRONTEND_PORT") — o app do dev foi publicado em ${NEW_PORT}"
    FRONTEND_PORT="$NEW_PORT"
    env_set DEV_FRONTEND_PORT "$FRONTEND_PORT"
else
    pass "porta ${FRONTEND_PORT} livre (app)"
fi

if ! port_free_for_us "$CADDY_HTTP_PORT" caddy; then
    NEW_PORT="$(pick_free_port "$CADDY_HTTP_PORT")" || die "não achei porta livre para o Caddy (a partir de ${CADDY_HTTP_PORT})"
    warn "a porta ${CADDY_HTTP_PORT} está ocupada por $(port_holder "$CADDY_HTTP_PORT") — o Caddy do dev foi publicado em ${NEW_PORT}"
    CADDY_HTTP_PORT="$NEW_PORT"
    env_set DEV_CADDY_HTTP_PORT "$CADDY_HTTP_PORT"
else
    pass "porta ${CADDY_HTTP_PORT} livre (Caddy HTTP)"
fi

# CORS acompanha as portas escolhidas (o app acessa a API pelo mesmo host,
# mas deixar a origem correta evita dor de cabeça com chamadas diretas).
# A origem do Caddy entra na lista porque ele passou a servir o app: quem
# abre por lá também é uma origem do ambiente de dev.
env_set CORS_ORIGIN "http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT},http://localhost:${CADDY_HTTP_PORT}"

# -----------------------------------------------------------------
# 5. Sobe o stack
#    Só os serviços do dev — router/optimizer/tiles (precisam de dados de
#    mapa) e os profiles ws-gateway/pagarme-webhook ficam de fora.
# -----------------------------------------------------------------
echo ""
echo "Subindo o stack '${PROJECT}' (${SERVICES[*]})..."
# `--remove-orphans`: o `up` é escopado ao projeto compose '${PROJECT}'
# (pdv-dev), então os órfãos removidos são containers deste projeto
# (serviço que saiu do compose, renomeado, etc.) — o stack de produção
# (projeto 'pdv') não é tocado.
if ! dc up -d --build --remove-orphans "${SERVICES[@]}"; then
    warn "docker compose up falhou — logs:"
    dc logs --tail 40 >&2 || true
    die "não foi possível subir o stack de dev"
fi
pass "containers criados/atualizados"

echo "Aguardando os serviços ficarem prontos..."
if ! wait_service postgres healthy 120; then
    dc logs --tail 40 postgres >&2 || true
    die "o Postgres não ficou healthy em 120s"
fi
pass "postgres healthy"

if ! wait_service redis healthy 60; then
    die "o Redis não ficou healthy em 60s"
fi
pass "redis healthy"

if ! wait_service backend healthy 300; then
    # Um restart resolve o caso do processo do node ter morrido junto com o
    # Postgres (ver §7). Antes de culpar as migrations, tenta reiniciar.
    warn "o backend não ficou healthy — reiniciando o container"
    dc restart backend >/dev/null 2>&1 || true
    if ! wait_service backend healthy 180; then
        dc logs --tail 60 backend >&2 || true
        die "o backend não ficou healthy em 300s (as migrations podem ter falhado — veja o log acima)"
    fi
fi
pass "backend healthy"

if ! wait_service frontend healthy 180; then
    dc logs --tail 40 frontend >&2 || true
    die "o frontend (Vite) não ficou healthy em 180s"
fi
pass "frontend healthy"

if ! wait_service caddy running 60; then
    dc logs --tail 40 caddy >&2 || true
    die "o caddy não ficou running em 60s"
fi
pass "caddy running"

# -----------------------------------------------------------------
# 6. Seed
#    Roda DENTRO do container do backend (o banco é `postgres:5432` na
#    rede do projeto). O seed é idempotente: se o store_settings já
#    existir, ele só reconcilia os usuários demo que faltam.
# -----------------------------------------------------------------
if [[ "$DO_SEED" -eq 1 ]]; then
    echo ""
    echo "Rodando o seed de demonstração (dentro do container do backend)..."
    if ! dc exec -T backend npm run seed; then
        die "o seed falhou — veja: $DC logs backend"
    fi
    pass "seed aplicado"
else
    echo ""
    warn "seed pulado (--no-seed) — os dados do banco foram preservados"
fi

# -----------------------------------------------------------------
# 7. Probes — só é impresso o que respondeu
# -----------------------------------------------------------------
echo ""
echo "Verificando as URLs..."

APP_URL="http://localhost:${FRONTEND_PORT}"
API_VIA_APP_URL="${APP_URL}/api/health"
CADDY_URL="http://localhost:${CADDY_HTTP_PORT}"

# Roda todos os probes e deixa o resultado em APP_CODE / API_CODE /
# BACKEND_CODE / CADDY_CODE / CADDY_API_CODE.
run_probes() {
    APP_CODE="$(http_code "$APP_URL")"
    API_CODE="$(http_code "$API_VIA_APP_URL")"
    CADDY_CODE="$(http_code "$CADDY_URL")"
    # Rota `api.localhost` do Caddyfile.devstack — o proxy do backend pelo
    # Caddy. O Host importa: sem ele a requisição cai no bloco `localhost`
    # (que serve o app), e não na rota da API.
    CADDY_API_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        -H 'Host: api.localhost' "${CADDY_URL}/health" 2>/dev/null)"
    [[ -n "$CADDY_API_CODE" ]] || CADDY_API_CODE="000"
    # O backend não publica porta: o probe dele é de dentro da rede do projeto.
    BACKEND_CODE="$(dc exec -T backend node -e \
        "fetch('http://127.0.0.1:3000/health').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('000');process.exit(0)})" \
        2>/dev/null | tr -d '\r' | grep -E '^[0-9]{3}$' | tail -1)"
    BACKEND_CODE="${BACKEND_CODE:-000}"
}

# O serviço de dev está de pé? (app e API são o que o usuário vai usar)
stack_is_serving() {
    [[ "$APP_CODE" == "200" && "$API_CODE" == "200" && "$BACKEND_CODE" == "200" ]]
}

run_probes

# Retry: quando o `up` recria o container do Postgres (mudança de config),
# as conexões do pool do backend são cortadas e o processo do node MORRE
# (o pg Pool emite 'error' sem handler). O container fica "running" mas
# ninguém atende. Um restart do backend resolve.
if ! stack_is_serving; then
    warn "o ambiente não respondeu (app=${APP_CODE}, api=${API_CODE}, backend=${BACKEND_CODE}) — reiniciando o backend"
    dc restart backend >/dev/null 2>&1 || true
    wait_service backend healthy 180 || true
    sleep 3
    run_probes
fi

if [[ "$APP_CODE" == "200" ]]; then
    pass "app respondeu 200 em ${APP_URL}"
else
    warn "o app respondeu ${APP_CODE} em ${APP_URL}"
fi
if [[ "$API_CODE" == "200" ]]; then
    pass "API respondeu 200 em ${API_VIA_APP_URL} (proxy do Vite -> backend)"
else
    warn "a API respondeu ${API_CODE} em ${API_VIA_APP_URL}"
fi
if [[ "$BACKEND_CODE" == "200" ]]; then
    pass "backend respondeu 200 em http://backend:3000/health (rede do projeto)"
else
    warn "o backend respondeu ${BACKEND_CODE} no probe interno"
fi

# O script promete URLs que funcionam: se o ambiente não está de pé, isso é
# uma falha do setup (exit 1), não um aviso.
if ! stack_is_serving; then
    echo "" >&2
    dc logs --tail 40 backend >&2 || true
    die "o ambiente de dev não está atendendo (app=${APP_CODE}, api=${API_CODE}, backend=${BACKEND_CODE}) — veja os logs acima"
fi

# -----------------------------------------------------------------
# 8. Resumo
# -----------------------------------------------------------------
cat <<EOF

=== PDV dev no ar (projeto compose '${PROJECT}') ===

  App (Vite)         ${APP_URL}   [HTTP ${APP_CODE}]   (caminho do HMR)
  API via app        ${API_VIA_APP_URL}   [HTTP ${API_CODE}]
  Backend (API)      http://backend:3000  [HTTP ${BACKEND_CODE}]  (sem porta publicada: só o Caddy e o Vite falam com ele)

  Postgres           localhost:${POSTGRES_PORT}  (user: pdv · senha: pdv_password · db: pdv)
  Redis              rede interna do projeto (sem porta publicada)

EOF

if [[ "$CADDY_CODE" == "200" ]]; then
    cat <<EOF
  Caddy (dev)        ${CADDY_URL}   [HTTP ${CADDY_CODE}]  (entrada alternativa do app; HTTP puro, sem TLS)
                     API pelo Caddy: ${CADDY_URL}/health com Host 'api.localhost'   [HTTP ${CADDY_API_CODE}]

EOF
else
    cat <<EOF
  Caddy (dev)        ${CADDY_URL}   [HTTP ${CADDY_CODE}]  <- NÃO está servindo o app
                     A rota 'localhost' do Caddyfile.devstack faz proxy para
                     'frontend:5173' (o Vite do container do frontend). Se não
                     voltar 200, use a URL do Vite acima — é o caminho do HMR.
                     API pelo Caddy: ${CADDY_URL}/health com Host 'api.localhost'   [HTTP ${CADDY_API_CODE}]

EOF
fi

cat <<EOF
  Login (e-mail + senha — identidade centralizada, docs/26):
    ana.ribeiro@pdv.local   / pdv1234   (garçom)
    carlos.lima@pdv.local    / pdv1234   (garçom)
    roberto.alves@pdv.local  / pdv1234   (gerente)
    caixa.teste@pdv.local    / pdv1234   (caixa)
    cozinha@pdv.local        / pdv1234   (cozinha)
    (a lista completa das contas sai no log do seed)

  Fallback por PIN (tela /login/pin):
    Ana Ribeiro 1234 · Carlos Lima 5678 · Roberto Alves 9999 · Caixa Teste 2468

  Comandos (a partir da raiz do repo):
    status:   ${DC} ps
    logs:     ${DC} logs -f backend
    derrubar: ${DC} down          (mantém os volumes do banco)
    recriar:  ${DC} down && ${DC} up -d --build --remove-orphans

  Hot reload: o backend e o frontend entram por bind mount — editar o código
  no host reinicia o container (tsx watch / Vite).

  O stack NÃO é derrubado ao sair deste script.
EOF

exit 0

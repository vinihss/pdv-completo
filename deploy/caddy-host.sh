#!/usr/bin/env bash
# ============================================================
# caddy-host.sh — instala / migra o proxy de produção para o HOST
# (systemd `pdv-caddy`), fora do Docker. Idempotente: serve tanto para
# INSTALAÇÃO NOVA (chamado por install.sh e por `switch.sh --install`) quanto
# para a MIGRAÇÃO de um VPS que hoje roda o Caddy como container (chamado à
# mão, DEPOIS do checkout da tag nova).
#
# Uso:
#   sudo sh deploy/caddy-host.sh                    # dir do próprio script
#   sudo sh deploy/caddy-host.sh --deploy-dir /root/pdv-completo/deploy
#
# (É um script bash — o `sh` funciona porque ele se reexecuta no bash; o
# shebang é `#!/usr/bin/env bash` para quem chamar `./caddy-host.sh`.)
#
# ---------- Por que tirar o Caddy do Docker ----------
# 1. Versão: o `caddy` do repositório oficial do Ubuntu é 2.6.2 e o container
#    roda 2.11.x — dois anos de correção (e de comportamento de TLS/HTTP)
#    entre os dois. Instalando o binário pelo repositório oficial do Caddy
#    (caddyserver.com/docs/install) — e o host ficam na MESMA versão.
# 2. Um processo a menos dentro do caminho crítico: o proxy deixa de depender
#    do Docker daemon para estar no ar (um `systemctl restart docker` não
#    derruba mais o HTTPS), e o reload vira `systemctl reload pdv-caddy`.
# 3. O `/etc/hosts` do host passa a ser a resolução dos upstreams
#    (`172.18.0.241 backend`, …) — daí os IPs FIXOS no compose e este
#    script ser dono do bloco de hosts.
#
# ---------- O que ele NÃO faz ----------
# - Não mexe no stack: nenhum container é parado/removido aqui (só recriado
#   via `compose up --no-deps` para os serviços alvo ganharem IP fixo, e o
#   container do Caddy antigo é só PARADO — fica para rollback).
# - Não altera a Caddyfile nem o ponteiro de upstream: quem decide upstream
#   continua sendo o switch.sh, como sempre.
# - Não roda em produção "por curiosidade": os passos 8 e 10 tocam containers
#   em execução (janela de ~1-2s na troca da porta 80/443).
#
# ROLLBACK MANUAL no fim de qualquer execução (passo 11).
# ============================================================

# Reexecução no bash: o script usa arrays/`mapfile`, que o `dash` (o `sh` do
# Ubuntu) não tem. Sem este guard, `sudo sh deploy/caddy-host.sh` morreria
# com erro de sintaxe em vez de rodar.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# ---------- Helpers ----------
say() { printf '\n\033[1m[caddy-host] %s\033[0m\n' "$*"; }
info() { printf '[caddy-host] %s\n' "$*"; }
warn() { printf '[caddy-host] AVISO: %s\n' "$*" >&2; }
die() {
  printf '\n[caddy-host] ERRO: %s\n' "$*" >&2
  exit 1
}

# ---------- Constantes (espelham o docker-compose.yml) ----------
NET_NAME="deploy_default"
NET_SUBNET="172.18.0.0/16"
MARK_BEGIN="# BEGIN PDV caddy-host"
MARK_END="# END PDV caddy-host"
UNIT_SRC="pdv-caddy.service" # template versionado no repo (placeholders @DEPLOY_DIR@)
UNIT_DST="/etc/systemd/system/pdv-caddy.service"
DATA_DIR="/var/lib/caddy" # XDG_DATA_HOME do unit (equivalente ao /data do container)
ENV_FILE=".env"
UPDATES_LINK="/srv/pdv-updates"

# Mesma tabela de `ipv4_address` do docker-compose.yml — se uma mudar lá, tem
# que mudar aqui (e no bloco de /etc/hosts). Faixa .241-.247: por fora da
# alocação sequencial do Docker, que começa em .2 e sobe.
ORDER=(
  backend
  backend-next
  frontend
  frontend-next
  pedidopublic
  ws-gateway
  pagarme-webhook
)
declare -A STATIC_IP=(
  [backend]=172.18.0.241
  [backend-next]=172.18.0.242
  [frontend]=172.18.0.243
  [frontend-next]=172.18.0.244
  [pedidopublic]=172.18.0.245
  [ws-gateway]=172.18.0.246
  [pagarme-webhook]=172.18.0.247
)
# Profiles que os serviços alvo podem estar atrás de — passar todos na hora do
# `up` evita depender de o compose ativar profile de serviço citado
# explicitamente (backend-next/frontend-next = canary; os dois Go = próprios).
COMPOSE_PROFILES=(--profile canary --profile ws-gateway --profile pagarme-webhook)

DEPLOY_DIR="$PWD"
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-dir)
      DEPLOY_DIR="${2:?--deploy-dir exige um caminho}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      die "argumento desconhecido: $1 (uso: $0 [--deploy-dir <path>])"
      ;;
  esac
done
# Caminho absoluto (o unit guarda o caminho; relativo quebraria quando o
# systemd mudasse de diretório) e com trailing barra removida, para o sed do
# template não gerar `//`.
DEPLOY_DIR="$(cd "$DEPLOY_DIR" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR%/}"
cd "$DEPLOY_DIR"

# ----------------------------------------------------------------------
# 1. Pré-condições — falhar AQUI é barato, falhar no passo 10 custa uptime
# ----------------------------------------------------------------------
step1_precondicoes() {
  say "1/11 pré-condições"
  [ "$(id -u)" -eq 0 ] ||
    die "root necessário (o unit vai para /etc/systemd/system e os certificados para $DATA_DIR). Rode com sudo."
  command -v docker >/dev/null 2>&1 || die "docker não encontrado no host"
  docker compose version >/dev/null 2>&1 || die "docker compose indisponível"
  command -v curl >/dev/null 2>&1 || die "curl não encontrado (é ele que confere 80/443 no passo 10)"
  [ -f docker-compose.yml ] || die "docker-compose.yml não encontrado em $DEPLOY_DIR"

  # O portão da migração: se o compose desta checkout AINDA tem o serviço
  # caddy, os passos seguintes dariam errado de formas confusas (IP fixo em
  # serviço que ainda publica porta, `--remove-orphans` matando o proxy no
  # meio do caminho). A ordem certa é: git checkout da tag nova → este
  # script → switch.sh.
  if docker compose -f docker-compose.yml config --services 2>/dev/null | grep -qx caddy; then
    die "o compose desta versão ainda declara o serviço 'caddy'.
   Checkout da versão nova primeiro — a migração roda DEPOIS do git checkout da tag:
     git fetch --prune origin && git checkout -f <tag-nova> && sudo sh deploy/caddy-host.sh"
  fi

  # Rede: já existe com este nome/subnet no VPS (foi o primeiro `up` que a
  # criou) → o compose reaproveita. Existe com OUTRO subnet → os
  # ipv4_address estariam fora da faixa e o compose recusaria (bom: falha
  # barata aqui em vez de container sem rede no passo 8). Não existe → tudo
  # bem, o `compose up` do passo 8 cria a partir da chave top-level nova.
  local subnets
  subnets="$(docker network inspect "$NET_NAME" -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' 2>/dev/null || true)"
  if [ -z "$subnets" ]; then
    info "rede $NET_NAME ainda não existe — será criada com $NET_SUBNET pelo compose (passo 8)"
    info "  (num VPS novo, confirme que a faixa $NET_SUBNET está livre: docker network ls)"
  elif printf '%s\n' "$subnets" | grep -qx "$NET_SUBNET"; then
    info "rede $NET_NAME ok ($NET_SUBNET)"
  else
    die "rede $NET_NAME existe com subnet diferente do esperado: $(printf '%s' "$subnets" | tr '\n' ' ') (esperado $NET_SUBNET).
   Os ipv4_address do compose e do /etc/hosts só fazem sentido nessa faixa.
   Ou remova a rede antiga (docker network rm $NET_NAME — só se nada importante usar), ou alinhe compose + hosts + este script na faixa que já existe."
  fi
}

# ----------------------------------------------------------------------
# 2. Binário do Caddy (repositório oficial, para paridade de versão)
# ----------------------------------------------------------------------
step2_binario() {
  say "2/11 binário do caddy"
  if command -v caddy >/dev/null 2>&1 && caddy version 2>/dev/null | grep -q '^v2\.'; then
    info "caddy já instalado ($(caddy version)) — não reinstalo"
  else
    info "instalando o caddy pelo repositório oficial (caddyserver.com/docs/install)"
    info "  o apt do Ubuntu só tem 2.6.2 (universe); o stack roda 2.11.x — versões iguais"
    apt-get update -qq
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
      gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
    caddy version | grep -q '^v2\.' || die "caddy instalado não é 2.x (saiu: $(caddy version))"
    info "instalado: $(caddy version)"
  fi

  # O pacote oficial do Caddy traz UM unit `caddy.service` (nome dele, não o
  # nosso) que quer subir e ocupar 80/443 — durante a migração o container
  # antigo tem as portas e ele falha; depois da virada, ele disputaria com o
  # pdv-caddy. Ninguém neste VPS usa o unit do pacote (o stack inteiro é
  # nosso), então desligar é seguro e evita a disputa silenciosa.
  if [ -f /lib/systemd/system/caddy.service ] || [ -f /etc/systemd/system/caddy.service ]; then
    systemctl disable --now caddy.service >/dev/null 2>&1 || true
    info "unit 'caddy.service' do pacote oficial desabilitada (80/443 é do pdv-caddy)"
  fi
}

# ----------------------------------------------------------------------
# 3. Unit systemd (a partir do template versionado no repo)
# ----------------------------------------------------------------------
step3_unit() {
  say "3/11 unit pdv-caddy.service"
  [ -f "$UNIT_SRC" ] || die "template $UNIT_SRC não encontrado ao lado deste script"
  local tmp
  tmp="$(mktemp)"
  # `|` como delimiter: o único caractere que não pode aparecer no path é
  # este, e caminho de deploy com `|` é improvável (muito menos com o
  # caminho versionado no próprio unit).
  sed "s|@DEPLOY_DIR@|$DEPLOY_DIR|g" "$UNIT_SRC" >"$tmp"
  if [ -f "$UNIT_DST" ] && cmp -s "$tmp" "$UNIT_DST"; then
    info "unit já está com este conteúdo ($UNIT_DST)"
  else
    install -m 0644 "$tmp" "$UNIT_DST"
    systemctl daemon-reload
    info "unit gerado/atualizado: $UNIT_DST (WorkingDirectory=$DEPLOY_DIR)"
  fi
  rm -f "$tmp"
  # `enable` e NÃO `start`: o proxy só assume a porta no passo 10, depois
  # da validação e da troca do container antigo. O enable garante o boot.
  systemctl enable pdv-caddy >/dev/null 2>&1 || systemctl enable pdv-caddy
  info "unit habilitado no boot (start fica para o passo 10)"
}

# ----------------------------------------------------------------------
# 4. Certificados TLS — reaproveitar o volume do container antigo
# ----------------------------------------------------------------------
step4_certificados() {
  say "4/11 certificados TLS"
  # Layout idêntico dos dois lados: no container XDG_DATA_HOME=/data (volume
  # pdv_caddy_data) ⇒ certs em /data/caddy/...; no host XDG_DATA_HOME=
  # /var/lib/caddy ⇒ /var/lib/caddy/caddy/... . Copiar o volume para cá é o
  # que evita REEMITIR os certificados: o Let's Encrypt tem rate limit de 5
  # certificados/semana por domínio, e um reset que reemite a cada troca de
  # host estoura o teto no meio de uma semana de operação.
  if [ -e "$DATA_DIR/caddy" ]; then
    info "$DATA_DIR/caddy já existe — dados do host preservados, nada a copiar"
  elif docker volume inspect pdv_caddy_data >/dev/null 2>&1; then
    mkdir -p "$DATA_DIR"
    cp -a /var/lib/docker/volumes/pdv_caddy_data/_data/. "$DATA_DIR/"
    info "certificados copiados do volume pdv_caddy_data → $DATA_DIR (sem reemitir TLS)"
    info "  (o volume NÃO é apagado — continua lá como backup até alguém removê-lo à mão)"
  else
    info "sem volume pdv_caddy_data e sem $DATA_DIR/caddy — o primeiro start emite certificados novos"
  fi
  # Autosave do Caddy (XDG_CONFIG_HOME do unit). O container guardava isso no
  # volume pdv_caddy_config; no host não precisamos copiar (o autosave é
  # regenerado), só garantir o diretório.
  mkdir -p "$DATA_DIR/config"
}

# ----------------------------------------------------------------------
# 5. .env — garantir as chaves que o caddy-assemble.sh lê no host
# ----------------------------------------------------------------------
ensure_env() {
  local key="$1" default="$2"
  # Só APPEND quando a chave NÃO existe. Uma linha existente (mesmo com outro
  # valor, mesmo comentada com outro formato) nunca é sobrescrita: quem
  # editou o .env mandou. O `^[[:space:]]*CHAVE=` não casa `# CHAVE=`,
  # então um comentário explicando a variável não engana a checagem.
  if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    info "$key já está no .env — preservado"
  else
    printf '\n# Adicionado por caddy-host.sh — mesmo default do docker-compose.yml (o .env do VPS\n# foi escrito antes destas chaves existirem e o deploy-on-tag.yml preserva só o que já lá está).\n%s=%s\n' \
      "$key" "$default" >>"$ENV_FILE"
    info "$key ausente no .env — linha adicionada com o default $default"
  fi
}

step5_env() {
  say "5/11 chaves do .env"
  if [ ! -f "$ENV_FILE" ]; then
    warn "$ENV_FILE não existe em $DEPLOY_DIR — nada a garantir; crie a partir de .env.example ANTES de subir o proxy (o validate do passo 9 vai reclamar de ROOT_DOMAIN)"
    return 0
  fi
  # ROOT_DOMAIN é a única sem default no próprio script (servir o domínio
  # errado é pior que não servir — ver caddy-assemble.sh, seção 1d); os
  # defaults abaixo são os MESMOS do compose, para o modo container continuar
  # idêntico ao que já roda.
  ensure_env ROOT_DOMAIN umamisushiarte.com.br
  ensure_env WS_BACKEND node
  ensure_env PAGARME_WEBHOOK_BACKEND node
}

# ----------------------------------------------------------------------
# 6. /etc/hosts (+ template do cloud-init) — o bloco dos upstreams
# ----------------------------------------------------------------------
# Gera o conteúdo do bloco, pulando nomes que já estejam mapeados FORA do
# bloco no arquivo (não duplicar: um nome com dois IPs resolvesse errado e o
# sintoma seria "502 intermitente", quase impossível de achar).
hosts_block() {
  local file="$1" name skipped=""
  local -a fora
  mapfile -t fora < <(
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" \
      '$0 == b { s = 1 } !s && NF >= 2 && $1 !~ /^#/ { for (i = 2; i <= NF; i++) print $i } $0 == e { s = 0 }' \
      "$file"
  )
  echo "$MARK_BEGIN"
  echo "# Gerado por caddy-host.sh — upstreams do proxy de produção (IPs fixos da bridge do Docker)."
  echo "# Não edite à mão: o próximo run reescreve este bloco. Faixa .241-.247 = fora da alocação automática do Docker."
  for name in "${ORDER[@]}"; do
    if printf '%s\n' "${fora[@]+"${fora[@]}"}" | grep -qx "$name"; then
      warn "$name já está mapeado fora do nosso bloco em $file — não duplico; confira se o IP antigo ainda é o certo"
      skipped="$skipped $name"
      continue
    fi
    printf '%s %s\n' "${STATIC_IP[$name]}" "$name"
  done
  echo "$MARK_END"
  [ -z "$skipped" ] || info "pulados em $file:$skipped"
}

update_hosts_file() {
  local file="$1" tmp
  [ -f "$file" ] || return 0
  tmp="$(mktemp)"
  # Remove o bloco antigo (idempotência: rodar duas vezes não acumula) e
  # grava de volta NO MESMO arquivo — `cat >` preserva inode, dono e
  # permissões, que em /etc/hosts importam (o cloud-init e o login do
  # systemd se importam com o arquivo, não com um mktemp novo ao lado).
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0 == b { s = 1 } !s { print } $0 == e { s = 0 }' \
    "$file" >"$tmp"
  hosts_block "$file" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
  info "bloco PDV gravado em $file"
}

step6_hosts() {
  say "6/11 /etc/hosts"
  update_hosts_file /etc/hosts
  # O cloud-init regenera /etc/hosts a cada boot a partir deste template
  # (cloud-init Ubuntu usa hosts.debian.tmpl com manage_etc_hosts: True) —
  # sem gravar AQUI também, o bloco sumiria no primeiro reboot e o proxy
  # voltaria a não resolver nenhum upstream (502 em tudo, "de repente").
  if [ -f /etc/cloud/templates/hosts.debian.tmpl ]; then
    update_hosts_file /etc/cloud/templates/hosts.debian.tmpl
  else
    info "sem /etc/cloud/templates/hosts.debian.tmpl (não é Ubuntu cloud-init) — só /etc/hosts"
  fi
}

# ----------------------------------------------------------------------
# 7. Symlink /srv/pdv-updates (a Caddyfile não muda: root /srv/pdv-updates)
# ----------------------------------------------------------------------
step7_symlink() {
  say "7/11 symlink de artefatos do auto-update"
  local target="$DEPLOY_DIR/updates"
  # O diretório tem que existir com DONO DO USUÁRIO DE DEPLOY, não root: o
  # scp do job build-desktop (CI) grava nele e falharia com permission denied
  # se root o tivesse criado 755. Por isso o chown para $SUDO_USER quando
  # este script roda via sudo.
  if [ ! -d "$target" ]; then
    mkdir -p "$target"
    if [ -n "${SUDO_USER:-}" ]; then
      chown "$SUDO_USER":"$(id -gn "$SUDO_USER")" "$target"
      info "$target criado com dono $SUDO_USER"
    else
      warn "$target criado como root — rode: chown \$(id -u):\$(id -g) $target (o CI precisa gravar aqui)"
    fi
  fi
  if [ -L "$UPDATES_LINK" ]; then
    if [ "$(readlink "$UPDATES_LINK")" = "$target" ]; then
      info "$UPDATES_LINK já aponta para $target"
    else
      warn "$UPDATES_LINK apontava para $(readlink "$UPDATES_LINK") — trocando (symlink é gerenciado por este script)"
      ln -sfn "$target" "$UPDATES_LINK"
    fi
  elif [ -e "$UPDATES_LINK" ]; then
    warn "$UPDATES_LINK existe e NÃO é symlink — não sobrescrevo; avalie mover para $target e linkar à mão"
  else
    ln -s "$target" "$UPDATES_LINK"
    info "$UPDATES_LINK → $target"
  fi
}

# ----------------------------------------------------------------------
# 8. IPs fixos nos serviços que estão RODANDO agora
# ----------------------------------------------------------------------
svc_running() {
  printf '%s\n' "${RUNNING_SERVICES[@]+"${RUNNING_SERVICES[@]}"}" | grep -qx "$1"
}

wait_svc_ready() {
  local svc="$1" id state
  local deadline=$((SECONDS + 180))
  id="$(docker compose -f docker-compose.yml ps -q --all "$svc" 2>/dev/null | head -1)"
  [ -n "$id" ] || die "$svc: compose não devolveu container após o up"
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo desconhecido)"
    case "$state" in
      healthy | running)
        return 0
        ;;
      unhealthy | exited | dead)
        docker compose -f docker-compose.yml logs --tail=40 "$svc" >&2 || true
        die "$svc não ficou pronto (estado: $state)"
        ;;
    esac
    sleep 2
  done
  die "$svc não ficou pronto em 180s (estado: ${state:-desconhecido})"
}

step8_ips() {
  say "8/11 aplicando IPs fixos"
  local svc ip id
  mapfile -t RUNNING_SERVICES < <(
    docker compose -f docker-compose.yml ps --status running --services 2>/dev/null || true
  )
  # Só os que estão RODANDO: recriar um serviço parado aqui (a) tiraria ele
  # do estado "parado esperando promote", que é o estado normal do par
  # azul/verde, e (b) subiria instância que ninguém pediu. Serviço parado
  # ganha o IP fixo no próximo promote do switch, que já usa o compose novo.
  local -a alvos=()
  for svc in "${ORDER[@]}"; do
    if svc_running "$svc"; then alvos+=("$svc"); fi
  done
  if [ "${#alvos[@]}" -eq 0 ]; then
    info "nenhum serviço alvo rodando — no-op (instalação nova: os containers já nascem com IP fixo)"
    return 0
  fi
  info "recriando com IP fixo: ${alvos[*]} (sem --build, sem tocar nos demais)"
  # Por que é seguro com o container do caddy AINDA no ar (migração): ele
  # resolve os upstreams pela DNS interna do Docker (embedded DNS em
  # 127.0.0.11), que acompanha os containers durante a recriação e passa a
  # responder com o IP novo na hora. Quem NÃO acompanha é o /etc/hosts do
  # HOST — e é justamente ele que o passo 6 acabou de apontar para os IPs
  # fixos que estes containers vão receber.
  for svc in "${alvos[@]}"; do
    docker compose -f docker-compose.yml "${COMPOSE_PROFILES[@]}" up -d --no-deps "$svc"
    wait_svc_ready "$svc"
    id="$(docker compose -f docker-compose.yml ps -q --all "$svc" | head -1)"
    ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET_NAME\").IPAddress}}" "$id" 2>/dev/null || true)"
    if [ "$ip" != "${STATIC_IP[$svc]}" ]; then
      die "$svc está com IP '${ip:-nenhum}', esperado ${STATIC_IP[$svc]}.
   Quase sempre é a rede $NET_NAME com outro subnet (o passo 1 avisa disso) —
   sem IP certo o proxy do host não resolve o nome e o resultado é 502."
    fi
    info "$svc → $ip (confere com o /etc/hosts)"
  done
}

# ----------------------------------------------------------------------
# 9. Validar a config com o MESMO env do unit
# ----------------------------------------------------------------------
step9_validate() {
  say "9/11 caddy-assemble.sh validate"
  # Mesmo trio de Environment do pdv-caddy.service: validar com env DIFERENTE
  # do que o unit vai usar seria validar outra coisa. O ROOT_DOMAIN/WS_BACKEND
  # sai do .env pelo passo 0 do próprio script (PDV_ENV_FILE).
  if ! env \
    PDV_CADDY_CONFIG="$DEPLOY_DIR/Caddyfile" \
    PDV_UPSTREAM_STATE="$DEPLOY_DIR/state/active-upstream" \
    PDV_ENV_FILE="$DEPLOY_DIR/$ENV_FILE" \
    sh "$DEPLOY_DIR/caddy-assemble.sh" validate; then
    die "validação falhou — o proxy antigo (se houver) continua no ar; corrija e rode de novo"
  fi
  info "config válida"
}

# ----------------------------------------------------------------------
# 10. Troca da porta 80/443 (a janela de ~1-2s do cutover)
# ----------------------------------------------------------------------
step10_swap() {
  say "10/11 assumindo as portas 80/443"
  local project cid state domain
  # `old_cid` é GLOBAL de propósito: o passo 11 imprime o id no resumo de
  # rollback. Só é preenchido quando o container antigo foi PARADO aqui — se
  # o start falhar, ele é re-startado antes do die, e o resumo nem roda.
  old_cid=""
  # Nome do projeto = basename do diretório (a regra default do compose),
  # respeitando COMPOSE_PROJECT_NAME quando definido. NADA de hardcoded
  # "deploy-caddy-1": o nome do container depende do nome do projeto.
  project="${COMPOSE_PROJECT_NAME:-$(basename "$DEPLOY_DIR")}"
  cid="$(docker ps -aq \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=caddy" | head -1)"
  if [ -z "$cid" ]; then
    # Fallback para o diretório ter sido renomeado / projeto diferente:
    # serviço `caddy` com a MESMA imagem do stack (caddy:2-alpine). Com esse
    # filtro a chance de pegar o container errado é mínima, e ainda assim o
    # aviso diz qual container foi.
    cid="$(docker ps -aq --filter "label=com.docker.compose.service=caddy" \
      --filter "ancestor=caddy:2-alpine" | head -1)"
    [ -z "$cid" ] || warn "container do caddy fora do projeto '$project' — achei por label+imagem: $cid"
  fi

  # Domínio para os probes: HOST: certo no HTTP e SNI certo no HTTPS (um
  # `curl https://127.0.0.1/` levaria cert errado e falharia à toa).
  # Preferir ROOT_DOMAIN: ele é o apex que TEM site na Caddyfile. O apex de
  # DOMAIN pode não ter bloco nenhum (ex.: `labolabe.tech` sem bloco, só
  # `*.labolabe.tech`) e o probe HTTPS daria 000/exit 35, abortando o cutover
  # com rollback. ROOT_DOMAIN vazio/ausente → aí sim DOMAIN.
  if [ -f "$ENV_FILE" ]; then
    domain="$(grep -E '^[[:space:]]*ROOT_DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2- |
      sed 's/^[[:space:]]*["'"'"']//; s/["'"'"'][[:space:]]*$//; s/[[:space:]]*#.*$//' || true)"
    if [ -z "$domain" ]; then
      domain="$(grep -E '^[[:space:]]*DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2- |
        sed 's/^[[:space:]]*["'"'"']//; s/["'"'"'][[:space:]]*$//; s/[[:space:]]*#.*$//' || true)"
    fi
  else
    domain=""
  fi

  if [ -n "$cid" ]; then
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo desconhecido)"
    if [ "$state" = "running" ]; then
      old_cid="$cid"
      info "parando o container do caddy antigo ($cid) — janela de ~1-2s até o unit responder"
      # stop e NÃO rm: o container fica parado como backup do rollback
      # (o compose novo nem sabe mais que ele existe — é um órfão, e o
      # próximo `up --remove-orphans` do switch que o limpa, DEPOIS da virada).
      docker stop "$cid" >/dev/null
    else
      info "container do caddy antigo já parado ($state) — só subo o unit"
    fi
  else
    info "nenhum container do caddy no projeto '$project' (instalação nova) — é só subir o unit"
  fi

  # O start em si: o ExecStart roda o assemble (valida de novo) e só então
  # o `caddy run` ocupa as portas.
  if ! systemctl start pdv-caddy; then
    [ -z "$old_cid" ] || { docker start "$old_cid" >/dev/null; warn "proxy antigo RESTAURADO ($old_cid)"; }
    die "systemctl start pdv-caddy falhou — veja: journalctl -u pdv-caddy -n 50"
  fi

  # Confirmar que ele RESPONDE, não só que o processo existe. Os probes
  # medem o PROXY, não o app: o que se prova aqui é "80/443 falando
  # HTTP(S) com certificado válido para o domínio" — a saúde do backend é o
  # portão do switch.sh/install.sh, não deste script. Por isso o probe não
  # usa `curl -f`: ele olha o código. 502 tem que passar quando NENHUM app
  # está no ar (instalação nova: este script roda antes do `up`), e 000
  # (conexão recusada ou TLS/cert errado — exit 60 do curl) tem que falhar
  # sempre. Na migração/reinstalação há APP NO AR — o par vivo `-next`
  # (`backend-next`/`frontend-next` rodando, o par normal parado) ou o par
  # normal — e aí 5xx é sinal de upstream não resolvido (bloco de /etc/hosts
  # faltando ou IP errado) e não pode passar, senão o cutover validaria um
  # proxy 502.
  local backend_no_ar=0
  if docker compose -f docker-compose.yml ps --status running --services 2>/dev/null |
    grep -qE '^(backend|backend-next|frontend|frontend-next)$'; then
    backend_no_ar=1
  fi
  local deadline=$((SECONDS + 120)) ok=0 http_cmd https_cmd code_http code_https
  if [ -n "$domain" ]; then
    http_cmd=(-sS -m 5 -o /dev/null -H "Host: $domain" "http://127.0.0.1:80/")
    # Sem `-f` de propósito: quem julga é o código via -w abaixo. Com -f o
    # curl sairia 22 num 502 e a leitura dependeria do exit, não do código.
    https_cmd=(-sS -m 10 -o /dev/null --resolve "$domain:443:127.0.0.1" "https://$domain/")
  else
    warn "nenhum DOMAIN/ROOT_DOMAIN no .env — probe sem Host/SNI (só confere que 80/443 respondem)"
    http_cmd=(-sS -m 5 -o /dev/null "http://127.0.0.1:80/")
    https_cmd=(-sSk -m 10 -o /dev/null "https://127.0.0.1:443/")
  fi
  # Fecha sobre `backend_no_ar` — instalação nova (nenhum app rodando → 0 →
  # 502 passa) vs migração/reinstalação (par vivo `-next` ou par normal →
  # 1 → 5xx falha). É por isso que a função nasce aqui e não no topo do
  # script.
  proxy_responde() {
    local code="$1"
    case "$code" in
      "" | 000) return 1 ;;
    esac
    if [ "$backend_no_ar" = "1" ]; then
      case "$code" in
        5??) return 1 ;;
      esac
    fi
    return 0
  }
  while [ "$SECONDS" -lt "$deadline" ]; do
    code_http="$(curl "${http_cmd[@]}" -w '%{http_code}' 2>/dev/null || true)"
    code_https="$(curl "${https_cmd[@]}" -w '%{http_code}' 2>/dev/null || true)"
    if systemctl is-active --quiet pdv-caddy &&
      proxy_responde "$code_http" && proxy_responde "$code_https"; then
      ok=1
      break
    fi
    sleep 2
  done
  if [ "$ok" != "1" ]; then
    [ -z "$old_cid" ] || { docker start "$old_cid" >/dev/null; warn "proxy antigo RESTAURADO ($old_cid)"; }
    die "pdv-caddy não respondeu em 120s (últimos códigos: HTTP=${code_http:-?} HTTPS=${code_https:-?}).
   Veja: journalctl -u pdv-caddy -n 50 — e, se o .env não tem ROOT_DOMAIN, o passo 5 é o suspeito.
   000 no HTTPS costuma ser certificado (rate limit do Let's Encrypt ou domínio errado)."
  fi
  info "pdv-caddy ativo e respondendo em 80/443 (HTTP ${code_http}, HTTPS ${code_https}; ${domain:-sem domínio})"
}

# ----------------------------------------------------------------------
# 11. Resumo (com o rollback à mão)
# ----------------------------------------------------------------------
step11_resumo() {
  say "11/11 concluído"
  cat <<EOF
  Proxy de produção: systemd 'pdv-caddy' (enable feito; sobe no boot)
    status:  systemctl status pdv-caddy
    log:     journalctl -u pdv-caddy -f
    reload:  systemctl reload pdv-caddy      # troca de upstream via switch.sh
  Upstreams: bloco '$MARK_BEGIN' em /etc/hosts (+ template do cloud-init)
  Certificados: $DATA_DIR (copiados do volume pdv_caddy_data, se existia)

  ROLLBACK MANUAL (volta para o container, se precisar):
    systemctl stop pdv-caddy && docker start ${old_cid:-<id-do-container-caddy>}
  Depois disso o container volta a servir 80/443 (o compose novo não o
  gerencia mais — ele é órfão; o próximo './switch.sh' pode removê-lo com
  --remove-orphans, então faça o rollback antes de rodar qualquer switch).

  Próximo passo (migração): ./switch.sh   — o reload agora é do host, e o
  switch já fala com o unit (has_service caddy = falso ⇒ caminho host).
EOF
}

# ----------------------------------------------------------------------
# Ordem — e por que o swap é o penúltimo
# ----------------------------------------------------------------------
step1_precondicoes
step2_binario
step3_unit
step4_certificados
step5_env
step6_hosts
step7_symlink
step8_ips
step9_validate
step10_swap
step11_resumo

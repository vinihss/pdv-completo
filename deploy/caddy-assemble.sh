#!/bin/sh
# ============================================================
# caddy-assemble.sh — monta a configuração do Caddy e sobe/recarrega o
# proxy a partir dela. Roda em DOIS lugares, com o mesmo conteúdo:
#
#   - produção: no HOST, pelo unit systemd `pdv-caddy` (Rota B — o Caddy
#     saiu do Docker; o env vem do `.env` via PDV_ENV_FILE, passo 0);
#   - stack local/dev: DENTRO do container do Caddy, como antes (o env vem
#     do `environment:` do serviço no compose).
#
# Por que existir: a Caddyfile do repo tem o upstream como variável
# (`{$PDV_BACKEND_UPSTREAM:backend:3000}`, e `{$PDV_WS_UPSTREAM:...}`
# para o /realtime, que tem duas implementações possíveis), e o nome do
# serviço ativo muda a cada deploy sem downtime (backend ↔ backend-next).
# Montar a config no momento do run/reload significa que:
#   - o repo no VPS continua sendo a fonte da verdade (a Caddyfile do
#     git é a que roda, sem arquivo gerado no host);
#   - o host só guarda o PONTEIRO de 1 linha por chave (qual serviço
#     está no ar), e esse ponteiro sobrevive a restart do proxy;
#   - a troca acontece por `caddy reload` (gracioso), e não por
#     recriar o processo/container — que era 1-3s de queda total.
#
# Uso (chamado pelo compose, pelo unit pdv-caddy e pelo deploy/switch.sh):
#   caddy-assemble.sh run       → entrypoint (boot)
#   caddy-assemble.sh reload    → aplica a config nova sem derrubar o proxy
#   caddy-assemble.sh validate  → só valida (não sobe nem recarrega)
#
# ---------- O que este script NÃO faz: gerar a Caddyfile ----------
# O nome "assemble" é anterior à topologia atual: existiu uma versão que
# concatenava um arquivo gerado no host (`$OUT`) com os blocos de
# multi-tenant. Hoje a Caddyfile do git é a config INTEIRA — nada é gerado,
# nada é concatenado — e os endereços parametrizados (`app.`, `api.` e o
# wildcard `*.`) já estão nela, na ordem que o Caddy precisa (específicos
# antes do wildcard). O que sobra para este script é resolver o upstream
# ativo (passos 1 a 1c) e validar antes de aplicar.
# ============================================================
set -eu

STATE_FILE="${PDV_UPSTREAM_STATE:-/etc/pdv/active-upstream}"
CONFIG="${PDV_CADDY_CONFIG:-/etc/caddy/Caddyfile}"
MODE="${1:-run}"
GATEWAY_UPSTREAM="ws-gateway:8080"
PAGARME_UPSTREAM="pagarme-webhook:8080"

# ---------- 0. env file (o caminho do HOST, sem mudar o do container) ----------
# Desde a Rota B o proxy de produção NÃO é container: o unit `pdv-caddy`
# roda este script no host, e lá não existe o `environment:` do serviço
# `caddy` do compose para fornecer `ROOT_DOMAIN`/`WS_BACKEND`/etc. O unit —
# e, no cutover, o `caddy-host.sh` — seta `PDV_ENV_FILE` apontando para o
# `.env` do deploy, e este bloco carrega dele: só as 4 chaves do allowlist,
# e só o que já não estiver preenchido no ambiente (env existente vence; o
# unit pode exportar um valor à mão).
#
# POR QUE ISSO NÃO MUDA NADA NO MODO CONTAINER: o carregamento só acontece
# quando `PDV_ENV_FILE` está definido, e ninguém o define no container (os
# composes `local`/`dev` nem citam a variável). Sem `PDV_ENV_FILE` este
# bloco é pulado inteiro (o guard abaixo usa `${PDV_ENV_FILE:-}`) e o
# `environment:` de sempre dos composes vale, inalterado — o auto-detect foi
# removido de propósito: ler o `.env` do deploy dentro do container (ex.:
# `PAGARME_WEBHOOK_BACKEND=go` no `.env`, hoje ignorado no stack local)
# mudaria o comportamento do que já roda.
#
# Parser próprio, NÃO `source` e NÃO `.`: um `.env` é texto de configuração,
# não script — `source` executaria o que estiver escrito lá (e o `.env` de
# produção tem valores com `$`, aspas e `#`). O formato aceito é o mesmo que
# o compose aceita em `.env`: `CHAVE=VALOR` em linha inteira, com aspas
# duplas/simples extremas removidas; comentário à direita só em valor não
# aspas. Qualquer outra linha é ignorada sem erro (é o mesmo tratamento
# "chave fora da allowlist" do ponteiro, abaixo).
if [ -r "${PDV_ENV_FILE:-}" ]; then
  while IFS= read -r pdv_line || [ -n "$pdv_line" ]; do
    # O `case` duplo é proposital: o primeiro reconhece a chave (só linhas
    # `CHAVE=…` com chave da allowlist entram) e o segundo garante que o
    # strip é da chave EXATA — `WS_BACKEND_X=…` não pode ser lido como
    # `WS_BACKEND`.
    case "$pdv_line" in
      DOMAIN=*) pdv_key="DOMAIN" ;;
      ROOT_DOMAIN=*) pdv_key="ROOT_DOMAIN" ;;
      WS_BACKEND=*) pdv_key="WS_BACKEND" ;;
      PAGARME_WEBHOOK_BACKEND=*) pdv_key="PAGARME_WEBHOOK_BACKEND" ;;
      *) continue ;;
    esac
    pdv_value="${pdv_line#"$pdv_key"=}"
    case "$pdv_value" in
      \'*\')
        pdv_value="${pdv_value#\'}"
        pdv_value="${pdv_value%\'}"
        ;;
      \"*\")
        pdv_value="${pdv_value#\"}"
        pdv_value="${pdv_value%\"}"
        ;;
      *) pdv_value="${pdv_value%% #*}" ;;
    esac
    # Aparar as pontas (mesma regra do parse do compose e do gate do
    # switch.sh): `KEY= valor` com espaço é válido, e o espaço não pode virar
    # parte do valor.
    pdv_value="${pdv_value#"${pdv_value%%[![:space:]]*}"}"
    pdv_value="${pdv_value%"${pdv_value##*[![:space:]]}"}"
    [ -n "$pdv_value" ] || continue
    # Só preenche o que está VAZIO/indefinido — um valor já exportado (pelo
    # unit, pelo `-e` de um `docker exec` ou pelo ambiente de quem chamou)
    # nunca é sobrescrito.
    case "$pdv_key" in
      DOMAIN)
        if [ -z "${DOMAIN:-}" ]; then DOMAIN="$pdv_value"; export DOMAIN; fi
        ;;
      ROOT_DOMAIN)
        if [ -z "${ROOT_DOMAIN:-}" ]; then ROOT_DOMAIN="$pdv_value"; export ROOT_DOMAIN; fi
        ;;
      WS_BACKEND)
        if [ -z "${WS_BACKEND:-}" ]; then WS_BACKEND="$pdv_value"; export WS_BACKEND; fi
        ;;
      PAGARME_WEBHOOK_BACKEND)
        if [ -z "${PAGARME_WEBHOOK_BACKEND:-}" ]; then
          PAGARME_WEBHOOK_BACKEND="$pdv_value"; export PAGARME_WEBHOOK_BACKEND
        fi
        ;;
    esac
  done <"$PDV_ENV_FILE"
fi

# ---------- 1. ponteiro de upstream ----------
# Arquivo de poucas linhas no formato CHAVE=VALOR. Ausente = primeira
# instalação (e aí valem os defaults do próprio Caddyfile). Não é
# "sourced": só as chaves conhecidas são aceitas, para que o
# arquivo nunca possa executar comando.
#
# A lista do `case` é a allowlist do ponteiro: uma chave nova que não
# estiver aqui é logada como "chave ignorada" e o proxy fica servindo o
# default da Caddyfile sem avisar ninguém. É por isso que
# `PDV_WS_UPSTREAM` precisou entrar.
if [ -r "$STATE_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      '' | '#'*) continue ;;
      PDV_BACKEND_UPSTREAM | PDV_FRONTEND_UPSTREAM | PDV_WS_UPSTREAM | PDV_PAGARME_UPSTREAM)
        [ -n "$value" ] || continue
        export "$key=$value"
        ;;
      *) echo "[caddy] chave ignorada no ponteiro: ${key}" >&2 ;;
    esac
  done <"$STATE_FILE"
fi

# ---------- 1b. quem serve o /realtime* ----------
# O realtime tem duas implementações possíveis (o `WsGateway` do Node, que
# está no ar, e o gateway em Go de `ws-gateway/`) e o Caddy só conhece um
# upstream. Precedência:
#
#   1. PDV_WS_UPSTREAM no ponteiro — botão de emergência; vale até o
#      próximo switch.sh, que reescreve o arquivo e descarta a linha.
#   2. WS_BACKEND=go no ambiente do container — a decisão do .env, que é
#      o que sobrevive a recreate e a deploy.
#   3. Sem nada disso, ACOMPANHA o ponteiro do backend. Fixar um literal
#      `backend:3000` aqui quebraria o realtime no primeiro switch: o
#      switch para a instância antiga no passo 5 e o /realtime ficaria
#      apontando para um container parado (todo WS quebrado, com o app
#      inteiro — REST — funcionando). Daí o item 3 ser a MESMA variável do
#      backend, não uma constante.
if [ -z "${PDV_WS_UPSTREAM:-}" ]; then
  case "${WS_BACKEND:-node}" in
    go) PDV_WS_UPSTREAM="$GATEWAY_UPSTREAM" ;;
    node) PDV_WS_UPSTREAM="${PDV_BACKEND_UPSTREAM:-backend:3000}" ;;
    *)
      # Valor fora do catálogo não pode ser adivinhado: cai no Node (que é o
      # caminho que está no ar e é o que o switch sabe manter) e avisa. O
      # sintoma de uma flag digitada errada é "nada mudou", indistinguível
      # de "o gateway está com problema" — sem esta linha o operador
      # acabaria caçando bug no gateway.
      echo "[caddy] WS_BACKEND='${WS_BACKEND}' não é node nem go — o /realtime fica no backend Node" >&2
      PDV_WS_UPSTREAM="${PDV_BACKEND_UPSTREAM:-backend:3000}"
      ;;
  esac
  export PDV_WS_UPSTREAM
fi

# ---------- 1c. quem serve o /webhooks/pagarme ----------
# O webhook do Pagar.me tem duas implementações possíveis (a rota do backend Node,
# que está no ar, e o serviço em Go de `pagarme-webhook/`) e o Caddy só conhece um
# upstream. Mesma precedência do /realtime, pelas mesmas Razões:
#
#   1. PDV_PAGARME_UPSTREAM no ponteiro — botão de emergência.
#   2. PAGARME_WEBHOOK_BACKEND=go no ambiente do container — a decisão do .env,
#      que é o que sobrevive a recreate e a deploy.
#   3. Sem nada disso, ACOMPANHA o ponteiro do backend.
#
# O item 3 é o MESMO motivo do realtime: fixar um literal `backend:3000`
# quebraria o webhook no primeiro switch, porque o switch para a instância antiga
# no fim e o /webhooks/pagarme ficaria apontando para um container parado. O
# sintoma seria o Pagar.me reenviando e ninguém recebendo — silencioso do lado do
# provedor, que simplesmente desiste.
#
# Esta é a ÚNICA diferença de risco em relação ao realtime, e vale a pena dizer:
# ligar `go` aqui com o serviço de pé mas o `PAGARME_DRAIN` desligado é um estado
# LEGÍTIMO (grava a inbox, o Node processa). Já ligar `go` com o drain ligado e o
# endpoint interno do Node ausente manda a fila de confirmação para a DLQ — e por
# isso o gate é default-deny lá dentro, não uma prática de operação.
if [ -z "${PDV_PAGARME_UPSTREAM:-}" ]; then
  case "${PAGARME_WEBHOOK_BACKEND:-node}" in
    go) PDV_PAGARME_UPSTREAM="$PAGARME_UPSTREAM" ;;
    node) PDV_PAGARME_UPSTREAM="${PDV_BACKEND_UPSTREAM:-backend:3000}" ;;
    *)
      echo "[caddy] PAGARME_WEBHOOK_BACKEND='${PAGARME_WEBHOOK_BACKEND}' não é node nem go — o /webhooks/pagarme fica no backend Node" >&2
      PDV_PAGARME_UPSTREAM="${PDV_BACKEND_UPSTREAM:-backend:3000}"
      ;;
  esac
  export PDV_PAGARME_UPSTREAM
fi

echo "[caddy] upstream ativo — backend: ${PDV_BACKEND_UPSTREAM:-backend:3000 (default)} | frontend: ${PDV_FRONTEND_UPSTREAM:-frontend:80 (default)} | realtime: ${PDV_WS_UPSTREAM} (WS_BACKEND=${WS_BACKEND:-node}) | webhook pagarme: ${PDV_PAGARME_UPSTREAM} (PAGARME_WEBHOOK_BACKEND=${PAGARME_WEBHOOK_BACKEND:-node})"

# ---------- 1d. ROOT_DOMAIN: a variável que NÃO tem default aqui ----------
# Os endereços `app.`, `api.` e o wildcard `*.` saem de `{$ROOT_DOMAIN}`, e a
# interpolação acontece no cliente do `caddy validate`/`caddy reload`. Vazia,
# ela não dá erro de sintaxe: dá `subject does not qualify for certificate:
# 'app.'` — que é o portão do switch.sh, com o proxy velho ainda no ar.
#
# Por que este bloco NÃO cai num default (ao contrário de WS_BACKEND e
# PAGARME_WEBHOOK_BACKEND, que caem): um default silencioso serve o domínio
# errado sem ninguém ver. O proxy sobe, o TLS sai, e a empresa entra em
# `app.<dominio-errado>` enquanto o domínio certo continua no ar do proxy
# velho — que é a mesma classe de falha que o `stream_close_delay` existe para
# não produzir (uma troca que "funciona" e corta quem está conectado).
# O valor padrão pertence a UM lugar por modo, nunca a este script: no
# container é o `ROOT_DOMAIN=${ROOT_DOMAIN:-...}` do compose (`local`/`dev`),
# no host é a linha do `.env` (garantida pelo `caddy-host.sh` e lida pelo
# passo 0); aqui a única regra é: vazio é erro, e o erro diz como resolver.
#
# A condição é o próprio arquivo de config, e não "a variável existe": o
# `Caddyfile.local` (stack de `--profile local`) e o `Caddyfile.dev` não usam
# `{$ROOT_DOMAIN}` em lugar nenhum, então exigir a variável lá quebraria a
# instalação local sem motivo.
#
# O `sed` tira as linhas de COMENTÁRIO antes do `grep` porque a Caddyfile
# documenta a variável (o cabeçalho dela, e a seção "os três blocos do meio")
# — sem isso a checagem pegaria o arquivo inteiro e o stack local pararia de
# subir por causa de um texto que explica a variável.
if [ -z "${ROOT_DOMAIN:-}" ] && sed 's/^[[:space:]]*#.*$//' "$CONFIG" 2>/dev/null |
  grep -q 'ROOT_DOMAIN'; then
  # Heredoc COM aspas: a mensagem é literal (`{$ROOT_DOMAIN}` é sintaxe do
  # Caddyfile, `$(docker compose ps -q caddy)` é o comando que o operador
  # precisa colar) — com `<<EOF` o shell expandiria os dois no `set -u` e a
  # mensagem morreria com "parameter not set" em vez de chegar ao operador.
  # O script serve os DOIS mundos (host systemd e container), então a
  # mensagem cita as duas correções.
  cat >&2 <<'EOF'
[caddy] ERRO: ROOT_DOMAIN vazio, e a Caddyfile usa {$ROOT_DOMAIN} (blocos app./api./*.)
   Sem ela o 'caddy validate' morre com:
     subject does not qualify for certificate: 'app.'
   — e o switch.sh aborta no passo 4/5, com o proxy antigo no ar.

   Neste HOST (proxy systemd pdv-caddy): a variável vem do .env do deploy
   (PDV_ENV_FILE), e a linha pode simplesmente não existir nele. Corrija no
   arquivo (é lá que a decisão mora) — ou exporte na chamada para um teste:
     echo 'ROOT_DOMAIN=<seu-dominio>' >> <deploy>/.env
     systemctl reload pdv-caddy
   O `sudo sh deploy/caddy-host.sh` garante a linha com o mesmo default do
   compose, sem sobrescrever uma existente.

   No CONTAINER (stacks local/dev): variável de ambiente só entra no BOOT
   dele. Um 'caddy reload' (docker exec) NÃO injeta env nova, e o container
   em pé pode ter sido criado antes da linha existir no compose — nesse caso
   a variável nunca chega, mesmo que o .env do host esteja correto. O
   switch.sh já resolve isso (lê o valor efetivo no 'docker compose config'
   e injeta com 'docker exec -e'); se você está rodando o reload na mão:
     docker exec -e ROOT_DOMAIN=<seu-dominio> $(docker compose ps -q caddy) \
       sh /srv/pdv-deploy/caddy-assemble.sh reload
EOF
  exit 1
fi

# ---------- 2. validar antes de aplicar ----------
# Este é o portão de segurança do switch: um nome de serviço errado no
# ponteiro tem que falhar aqui, com o proxy velho ainda no ar, e não
# depois de o `reload` ter trocado a config de todo mundo.
caddy validate --config "$CONFIG" --adapter caddyfile

# ---------- 3. aplicar ----------
#
# Este `case` é o ÚLTIMO comando do script e os três modos acabam nele
# (`run` e `reload` são `exec`; `validate` só sai). Não há nada depois — e é
# por isso que o bloco 4 do pedido público (o `if [ -n "${ROOT_DOMAIN:-}" ]`
# com `cat >> "$OUT"`) foi removido: ele estava DEPOIS deste `case`, com
# `run`/`reload` em `exec` (que troca o processo) e `validate` caindo fora,
# então nunca executou em nenhum dos três modos.
#
# E ele não podia funcionar: `$OUT` não existe neste script (a config é
# montada pelo `caddy` lendo a Caddyfile diretamente — é o que o cabeçalho
# acima descreve), e os endereços que ele escrevia — `umamisushiarte.com.br`,
# `www`, `app.${ROOT_DOMAIN}`, `api.${ROOT_DOMAIN}`, `*.${ROOT_DOMAIN}` — já
# estão no Caddyfile base, na ordem certa (específicos antes do wildcard).
# Reescrevê-los aqui duplicaria rota em vez de gerar uma.
case "$MODE" in
  run) exec caddy run --config "$CONFIG" --adapter caddyfile ;;
  reload) exec caddy reload --config "$CONFIG" --adapter caddyfile ;;
  validate) ;;
  *)
    echo "uso: $0 [run|reload|validate]" >&2
    exit 2
    ;;
esac

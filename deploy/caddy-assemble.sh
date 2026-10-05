#!/bin/sh
# ============================================================
# caddy-assemble.sh — monta a configuração do Caddy DENTRO do
# container e sobe/recarrega o proxy a partir dela.
#
# Por que existir: a Caddyfile do repo tem o upstream como variável
# (`{$PDV_BACKEND_UPSTREAM:backend:3000}`, e `{$PDV_WS_UPSTREAM:...}`
# para o /realtime, que tem duas implementações possíveis), e o nome do
# serviço ativo muda a cada deploy sem downtime (backend ↔ backend-next).
# Montar a config no container significa que:
#   - o repo no VPS continua sendo a fonte da verdade (a Caddyfile do
#     git é a que roda, sem arquivo gerado no host);
#   - o host só guarda o PONTEIRO de 1 linha por chave (qual serviço
#     está no ar), e esse ponteiro sobrevive a restart do container;
#   - a troca acontece por `caddy reload` (gracioso), e não por
#     recriar o container — que era 1-3s de queda total.
#
# Uso (chamado pelo compose e pelo deploy/switch.sh):
#   caddy-assemble.sh run       → entrypoint do container
#   caddy-assemble.sh reload    → aplica a config nova sem derrubar o proxy
#   caddy-assemble.sh validate  → só valida (não sobe nem recarrega)
# ============================================================
set -eu

STATE_FILE="${PDV_UPSTREAM_STATE:-/etc/pdv/active-upstream}"
CONFIG="${PDV_CADDY_CONFIG:-/etc/caddy/Caddyfile}"
MODE="${1:-run}"
GATEWAY_UPSTREAM="ws-gateway:8080"
PAGARME_UPSTREAM="pagarme-webhook:8080"

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

# ---------- 2. validar antes de aplicar ----------
# Este é o portão de segurança do switch: um nome de serviço errado no
# ponteiro tem que falhar aqui, com o proxy velho ainda no ar, e não
# depois de o `reload` ter trocado a config de todo mundo.
caddy validate --config "$CONFIG" --adapter caddyfile

# ---------- 3. aplicar ----------
case "$MODE" in
  run) exec caddy run --config "$CONFIG" --adapter caddyfile ;;
  reload) exec caddy reload --config "$CONFIG" --adapter caddyfile ;;
  validate) ;;
  *)
    echo "uso: $0 [run|reload|validate]" >&2
    exit 2
    ;;
esac

# ---------- 4. Bloco de pedido público multi-tenant (ROOT_DOMAIN) ----------
# Adiciona os blocos para o domínio público de pedidos.
# Esses blocos devem vir ANTES do wildcard *.ROOT_DOMAIN no Caddyfile gerado.
# O Caddyfile base (deploy/Caddyfile) já tem os blocos em ordem:
#   app.ROOT_DOMAIN, api.ROOT_DOMAIN, umamisushiarte.com.br, www redirect, *.ROOT_DOMAIN
# Este trecho gera os blocos condicionalmente quando ROOT_DOMAIN está definido.
if [ -n "${ROOT_DOMAIN:-}" ]; then
  cat >> "$OUT" <<BLOCKS

# ---------- Pedido público multi-tenant ----------
# Bloco específico para o domínio customizado do tenant (ex.: umamisushiarte.com.br)
# O Caddy não precisa mudar de roteamento: o domínio é resolvido pelo backend
# via GET /public/tenants/resolve (host -> schema)
umamisushiarte.com.br {
    encode gzip zstd
    reverse_proxy pedidopublic:80
}

# www redirect para raiz
www.umamisushiarte.com.br {
    redir https://umamisushiarte.com.br{uri} permanent
}

# Bloco app.* mantém a aplicação interna do PDV (garçom/cozinha/gerente/caixa)
app.${ROOT_DOMAIN} {
    import site
}

# API pública com header X-Tenant-Host para identificação de tenant
api.${ROOT_DOMAIN} {
    encode gzip zstd
    header {
        Access-Control-Allow-Origin https://*.${ROOT_DOMAIN} https://app.${ROOT_DOMAIN} https://umamisushiarte.com.br https://www.umamisushiarte.com.br
        Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization, X-Tenant-Slug, X-Tenant-Host, X-Forwarded-Host"
        Access-Control-Allow-Credentials true
        defer
    }

    @options method OPTIONS
    respond @options 204

    reverse_proxy backend:3000 {
        header_up X-Tenant-Host {host}
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto {scheme}
        header_up Host {host}
    }
}

# Wildcard: demais tenants por subdomínio
*.${ROOT_DOMAIN} {
    encode gzip zstd
    reverse_proxy pedidopublic:80
}
BLOCKS
fi

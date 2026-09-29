#!/bin/sh
# ============================================================
# caddy-assemble.sh — monta a configuração do Caddy DENTRO do
# container e sobe/recarrega o proxy a partir dela.
#
# Por que existir: a Caddyfile do repo tem o upstream como variável
# (`{$PDV_BACKEND_UPSTREAM:backend:3000}`), e o nome do serviço ativo
# muda a cada deploy sem downtime (backend ↔ backend-next). Montar a
# config no container significa que:
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

# ---------- 1. ponteiro de upstream ----------
# Arquivo de até 2 linhas no formato CHAVE=VALOR. Ausente = primeira
# instalação (e aí valem os defaults do próprio Caddyfile). Não é
# "sourced": só as duas chaves conhecidas são aceitas, para que o
# arquivo nunca possa executar comando.
if [ -r "$STATE_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      '' | '#'*) continue ;;
      PDV_BACKEND_UPSTREAM | PDV_FRONTEND_UPSTREAM)
        [ -n "$value" ] || continue
        export "$key=$value"
        ;;
      *) echo "[caddy] chave ignorada no ponteiro: ${key}" >&2 ;;
    esac
  done <"$STATE_FILE"
fi

echo "[caddy] upstream ativo — backend: ${PDV_BACKEND_UPSTREAM:-backend:3000 (default)} | frontend: ${PDV_FRONTEND_UPSTREAM:-frontend:80 (default)}"

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

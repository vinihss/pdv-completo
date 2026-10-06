#!/usr/bin/env bash
# ============================================================
# deploy-pedido-public.sh — republica SÓ o app público de pedidos
# (`apps/pedido-public`, o cardápio/pedido do cliente final).
#
# Para quê, se o `switch.sh` já sobe esse serviço: é o caminho de
# iteração. Mudou só o app público? Este script reconstrói e troca o
# container sem passar pelo rodízio azul/verde do backend/frontend — o
# PDV não é reiniciado e o Caddy não é recriado.
#
# O caminho normal de deploy continua sendo `./switch.sh` (o que o
# `deploy-on-tag.yml` chama): ele já constrói e promove o `pedidopublic`
# junto, com o healthcheck como portão. Este script é o atalho.
#
# ---------- O que este script NÃO faz mais ----------
# A versão anterior (PR #85) fazia `rsync` do `dist/` para
# `/var/www/pedido-public/` no host e depois `ssh ... systemctl reload
# caddy`. Nenhum dos dois funciona neste stack, e o pior era o segundo:
#
#   - `/var/www/` não é servido por nada aqui. O bundle do app público é
#     servido pelo container `pedidopublic` (nginx), e quem o publica é o
#     Caddy (`reverse_proxy pedidopublic:80`). O rsync jogava o dist num
#     diretório morto — o deploy "terminava com sucesso" e nada mudava
#     no ar, que é o modo de falha mais caro: um deploy verde que não
#     deployou.
#   - o Caddy deste stack NÃO é gerenciado por systemd. Ele roda como
#     container com `entrypoint: caddy-assemble.sh`, e a config é montada
#     dentro dele. `systemctl reload caddy` ou não encontra o serviço
#     (o VPS usa o Docker) ou, se findsse, recarregaria um Caddy que não
#     é o que está no ar.
#
# O caminho certo de recarregar o proxy é o do próprio stack:
#   docker compose exec caddy sh /srv/pdv-deploy/caddy-assemble.sh reload
# (é o `reload_caddy` do switch.sh, e vale o mesmo aviso: um `caddy reload`
# cru pula a resolução de upstream — o `/realtime*` voltaria sozinho para o
# backend Node, sem erro em lugar nenhum).
# ============================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# `up` só deste serviço. `--no-deps` é a mesma regra do switch.sh: o
# `pedidopublic` declara `depends_on: caddy`, e sem o `--no-deps` o
# compose recriaria o PROXY para trocar um nginx de estático — derrubando
# o `caddy reload` e as conexões WebSocket do salão por causa de uma
# página de cardápio.
echo "==> reconstruindo a imagem do pedido-public..."
docker compose -f docker-compose.yml build pedidopublic

echo "==> subindo o container do pedido-public (--no-deps: o caddy e o postgres ficam intocados)"
docker compose -f docker-compose.yml up -d --no-deps pedidopublic

# O mesmo portão do switch.sh: o `/healthz` do nginx é servido de verdade
# (ver apps/pedido-public/nginx.conf), então ele prova que o bundle subiu.
echo "==> aguardando o healthcheck do pedido-public..."
# Mesmo caminho do `wait_healthy` do switch.sh: `ps -q --all` traz o
# container mesmo PARADO (um `ps` sem `--all` só.listaria os que estão de
# pé, e um container que morreu viraria "não existe" em loop até o timeout,
# em vez de "parou com este erro").
deadline=$((SECONDS + 120))
state="ainda não subiu"
while [ "$SECONDS" -lt "$deadline" ]; do
  id="$(docker compose -f docker-compose.yml ps -q --all pedidopublic 2>/dev/null | head -1)"
  if [ -n "$id" ]; then
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}' "$id" 2>/dev/null || echo desconhecido)"
    case "$state" in
      healthy)
        echo "==> pedido-public healthy"
        state="healthy"
        break
        ;;
      unhealthy)
        echo "ERRO: pedido-public ficou unhealthy — log abaixo:" >&2
        docker compose -f docker-compose.yml logs --tail=40 pedidopublic >&2 || true
        exit 1
        ;;
    esac
    case "$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo desconhecido)" in
      exited | dead)
        echo "ERRO: pedido-public parou (estado: $state) — log abaixo:" >&2
        docker compose -f docker-compose.yml logs --tail=40 pedidopublic >&2 || true
        exit 1
        ;;
    esac
  fi
  sleep 2
done
if [ "$state" != "healthy" ]; then
  echo "ERRO: pedido-public não ficou healthy em 120s (estado: $state)" >&2
  docker compose -f docker-compose.yml logs --tail=40 pedidopublic >&2 || true
  exit 1
fi

# Não há reload do Caddy aqui, e isso é deliberado: o container troca o
# IP na rede do compose, mas o NOME `pedidopublic` continua o mesmo, e é
# pelo nome que o Caddy faz `reverse_proxy pedidopublic:80`. O proxy
# resolve o nome a cada conexão, então o tráfego novo já cai no container
# novo sem reload nenhum — e o `reload` derrubaria WebSocket à toa.
echo "==> pronto (o Caddy resolve 'pedidopublic' por nome: não precisa de reload)"
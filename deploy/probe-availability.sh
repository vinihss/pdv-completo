#!/bin/bash
# ============================================================
# probe-availability.sh — mede o downtime de verdade
# ============================================================
# "Deploy sem downtime" é uma afirmação; isto é a régua. O script fica
# apertando /health (através do Caddy, ou seja, pelo mesmo caminho do
# navegador) durante a troca e no fim diz qual foi o maior intervalo sem
# resposta e quantas requisições falharam.
#
# É o pós-step do job de deploy: se um deploy um dia derrubar o app por 2s,
# o número aparece no log do CI em vez de alguém abrir chamado.
#
# Uso:
#   ./probe-availability.sh --url http://localhost --seconds 120
#   ./probe-availability.sh --url ... --watch 0.5 &   # em background
#   ./probe-availability.sh --url ... --seconds 5      # teste rápido
#
# Saída: uma linha final com o veredito e o código de saída (0 = sem gap,
# 1 = houve falha), para o CI poder reprovar o deploy ruim.
# ============================================================
set -uo pipefail

URL="${PDV_PROBE_URL:-http://localhost}"
SECONDS_TOTAL=30
INTERVAL=0.2
JSON_OUT=""
WATCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url)
      URL="${2:?--url exige uma URL}"
      shift 2
      ;;
    --seconds)
      SECONDS_TOTAL="${2:?--seconds exige um número}"
      shift 2
      ;;
    --interval)
      INTERVAL="${2:?--interval exige um número}"
      shift 2
      ;;
    --json)
      JSON_OUT="${2:?--json exige um caminho}"
      shift 2
      ;;
    --watch)
      # Sem duração: roda até ser interrompido (usado com `&`).
      WATCH=1
      shift
      ;;
    -h | --help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "argumento desconhecido: $1" >&2
      exit 2
      ;;
  esac
done

# curl resolve a URL uma vez por requisição; o custo é o mesmo do probe.
PROBE="${URL%/}/health"
START_EPOCH=$(date +%s)
FAILURES=0
OK=0
MAX_GAP=0.0
GAP_START=""
TOTAL=0

echo "[probe] apertando ${PROBE} a cada ${INTERVAL}s (duração: $([ "$WATCH" = 1 ] && echo "até Ctrl-C" || echo "${SECONDS_TOTAL}s"))"

while true; do
  NOW_EPOCH=$(date +%s%3N)
  if [ "$TOTAL" -eq 0 ]; then
    GAP_START="$NOW_EPOCH"
  fi
  TOTAL=$((TOTAL + 1))
  # stderr quieto: a contagem no resumo já é o relatório do erro.
  if curl -fsS -m 2 -o /dev/null "$PROBE" 2>/dev/null; then
    OK=$((OK + 1))
    if [ -n "$GAP_START" ]; then
      GAP_MS=$((NOW_EPOCH - GAP_START))
      GAP_S=$(awk "BEGIN{printf \"%.3f\", $GAP_MS/1000}")
      if awk "BEGIN{exit !($GAP_S > $MAX_GAP)}"; then
        MAX_GAP="$GAP_S"
      fi
    fi
    GAP_START=""
  else
    FAILURES=$((FAILURES + 1))
  fi

  # Sem --watch a janela é fechada; com --watch o script só para no Ctrl-C.
  if [ "$WATCH" != "1" ]; then
    ELAPSED=$(( $(date +%s) - START_EPOCH ))
    [ "$ELAPSED" -ge "$SECONDS_TOTAL" ] && break
  fi
  sleep "$INTERVAL"
done

# Se a janela fechou em cima de uma sequência de falhas, essa sequência é
# um gap e precisa entrar na conta — senão o relatório mostraria 0.0s num
# deploy que derrubou o app do começo ao fim.
if [ -n "$GAP_START" ]; then
  GAP_S=$(awk "BEGIN{printf \"%.3f\", ($(date +%s%3N) - $GAP_START)/1000}")
  if awk "BEGIN{exit !($GAP_S > $MAX_GAP)}"; then
    MAX_GAP="$GAP_S"
  fi
  GAP_START=""
fi

AVAIL=$(awk "BEGIN{ if ($TOTAL>0) printf \"%.2f\", (100 * $OK / $TOTAL); else print \"0.00\" }")

echo
echo "============================================================"
echo " probe de disponibilidade — ${URL}"
echo "   requisições ...... ${TOTAL}"
echo "   com sucesso ...... ${OK}"
echo "   falhas ........... ${FAILURES}"
echo "   disponibilidade ... ${AVAIL}%"
echo "   maior gap ........ ${MAX_GAP}s"
echo "============================================================"

if [ -n "$JSON_OUT" ]; then
  printf '{"url":"%s","total":%s,"ok":%s,"failures":%s,"availability":%s,"maxGapSeconds":%s}\n' \
    "$URL" "$TOTAL" "$OK" "$FAILURES" "$AVAIL" "$MAX_GAP" >"$JSON_OUT"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "VEREDITO: houve indisponibilidade durante a janela observada."
  exit 1
fi
echo "VEREDITO: nenhuma requisição falhou."
exit 0

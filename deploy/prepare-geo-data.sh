#!/usr/bin/env bash
# Provisiona os dados geográficos de DEPLOY para os motores de rotas e tiles.
#
#   1. Monta o extrato OSM (.pbf) da região configurada.
#      Default: região metropolitana norte (Porto Alegre, São Leopoldo,
#      Novo Hamburgo, Canoas, Gravataí...) — recortada do Geofabrik Sul
#      com `osmium extract --bbox`.
#   2. Compila os tiles de rota do Valhalla (container one-shot).
#   3. Gera o .mbtiles vetorial (schema OpenMapTiles) para o TileServer GL.
#
# Uso:
#   ./prepare-geo-data.sh                    # região padrão (RMPA norte)
#   GEO_BBOX=minlon,minlat,maxlon,maxlat ./prepare-geo-data.sh   # outra área
#   GEO_OSM_URL=<url-do-pbf> GEO_NAME=<nome> ./prepare-geo-data.sh   # pbf pronto, sem recorte
#   GEO_FORCE=1 ./prepare-geo-data.sh        # regenera tudo mesmo que não mude
#
# Idempotente: o carimbo `osm/<GEO_NAME>.fonte` guarda a fonte+bbox usadas;
# quando elas mudam, o extrato e todos os artefatos derivados (tiles do
# Valhalla + .mbtiles) são regenerados automaticamente.
set -euo pipefail

cd "$(dirname "$0")"

GEO_NAME="${GEO_NAME:-metropole-poa}"
GEO_BBOX="${GEO_BBOX:--51.40,-30.20,-50.95,-29.55}"   # minlon,minlat,maxlon,maxlat
REGION_URL="${GEO_REGION_URL:-https://download.geofabrik.de/south-america/brazil/sul-latest.osm.pbf}"
OSM_DIR="map_data/osm"
SRC_DIR="$OSM_DIR/_fonte"
PBF_FILE="$OSM_DIR/$GEO_NAME.osm.pbf"
STAMP_FILE="$OSM_DIR/$GEO_NAME.fonte"
VALHALLA_DIR="map_data/valhalla"
TILESERVER_DIR="map_data/tileserver"
MBTILES_FILE="$TILESERVER_DIR/$GEO_NAME.mbtiles"

# Fonte desejada desta execução (guardada no carimbo para detectar mudanças):
#   GEO_OSM_URL definido  -> pbf direto da URL (ex.: BBBike), sem recorte;
#   caso contrário       -> região do Geofabrik recortada por GEO_BBOX.
if [[ -n "${GEO_OSM_URL:-}" ]]; then
  WANT_STAMP="url=$GEO_OSM_URL"
else
  WANT_STAMP="region=$REGION_URL bbox=$GEO_BBOX"
fi

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
log "0/3 Pré-requisitos"
if [[ -z "${GEO_OSM_URL:-}" ]] && ! command -v osmium >/dev/null 2>&1; then
  echo "ERRO: 'osmium' não encontrado — é ele que recorta o extrato regional." >&2
  echo "      Instale com:  sudo apt-get install -y osmium-tool" >&2
  exit 1
fi
[[ -n "${GEO_OSM_URL:-}" ]] && echo "Fonte: pbf direto ($GEO_OSM_URL)" \
                           || echo "Fonte: recorte de $REGION_URL | bbox: $GEO_BBOX"

# ---------------------------------------------------------------------------
log "1/3 Extrato OSM: $GEO_NAME"
mkdir -p "$OSM_DIR" "$SRC_DIR" "$VALHALLA_DIR" "$TILESERVER_DIR"

HAVE_STAMP="$(cat "$STAMP_FILE" 2>/dev/null || true)"
if [[ -s "$PBF_FILE" && "$HAVE_STAMP" == "$WANT_STAMP" && "${GEO_FORCE:-0}" != "1" ]]; then
  echo "Extrato já corresponde à fonte configurada (pulando): $PBF_FILE"
else
  if [[ -s "$PBF_FILE" || -n "$HAVE_STAMP" ]]; then
    echo "Fonte/bbox mudou (ou GEO_FORCE=1) — regenerando extrato e derivados."
  fi
  # Derruba os artefatos derivados da versão anterior antes de recompilar.
  rm -f "$VALHALLA_DIR/valhalla_tiles.tar" "$TILESERVER_DIR"/*.mbtiles
  rm -rf "$VALHALLA_DIR/valhalla_tiles"

  if [[ -n "${GEO_OSM_URL:-}" ]]; then
    echo "Baixando $GEO_OSM_URL ..."
    curl -fL --retry 3 -o "$PBF_FILE.part" "$GEO_OSM_URL"
    mv "$PBF_FILE.part" "$PBF_FILE"
  else
    REGION_FILE="$SRC_DIR/$(basename "$REGION_URL")"
    if [[ ! -s "$REGION_FILE" ]]; then
      echo "Baixando região-fonte (427 MB, cache em $SRC_DIR) ..."
      curl -fL --retry 3 -o "$REGION_FILE.part" "$REGION_URL"
      mv "$REGION_FILE.part" "$REGION_FILE"
    else
      echo "Região-fonte já em cache: $REGION_FILE"
    fi
    echo "Recortando bbox $GEO_BBOX (estratégia simple + reparo de referências) ..."
    # O complete_ways (default do osmium) estoura a RAM deste host: ele mantém
    # um bitmap por ID de node (≈1,5 GB só pelos IDs do arquivo do Sul) mais o
    # índice de ways. A estratégia simple cabe, mas deixa ways da borda com
    # referências pendentes — completamos com getid + merge a partir da fonte.
    TMP_PBF="$OSM_DIR/.${GEO_NAME}.tmp.osm.pbf"
    osmium extract --overwrite --strategy simple \
      --bbox "$GEO_BBOX" \
      --output "$TMP_PBF" \
      "$REGION_FILE"
    if osmium check-refs "$TMP_PBF" >/dev/null 2>&1; then
      mv "$TMP_PBF" "$PBF_FILE"
    else
      echo "Completando referências pendentes (ways que cruzam a borda) ..."
      MISSING_IDS="$OSM_DIR/.${GEO_NAME}.missing-ids.txt"
      MISSING_PBF="$OSM_DIR/.${GEO_NAME}.missing.osm.pbf"
      FIXED_PBF="$OSM_DIR/.${GEO_NAME}.fixed.osm.pbf"
      # check-refs -i sai com código 1 quando ACHAMOS refs pendentes (é o
      # esperado aqui) — daí o `|| true` para não abortar no set -e.
      osmium check-refs -i "$TMP_PBF" > "$MISSING_IDS" || true
      osmium getid -i "$MISSING_IDS" "$REGION_FILE" -o "$MISSING_PBF" --overwrite
      osmium merge "$TMP_PBF" "$MISSING_PBF" -o "$FIXED_PBF"
      mv "$FIXED_PBF" "$PBF_FILE"
      rm -f "$TMP_PBF" "$MISSING_IDS" "$MISSING_PBF"
      # Sanidade. Podem restar refs a nodes já APAGADOS do OSM (presentes em
      # nenhuma fonte) — avisa, mas segue: afeta só as ways correspondentes.
      if ! osmium check-refs "$PBF_FILE"; then
        echo "AVISO: restam referências a nodes apagados do OSM (não recuperáveis). Seguindo."
      fi
    fi
  fi
  printf '%s' "$WANT_STAMP" > "$STAMP_FILE"
fi
echo "Tamanho: $(du -h "$PBF_FILE" | cut -f1)"

# ---------------------------------------------------------------------------
log "2/3 Tiles de rota do Valhalla"
if compgen -G "$VALHALLA_DIR/valhalla_tiles.tar" > /dev/null || [[ -d "$VALHALLA_DIR/valhalla_tiles" ]]; then
  echo "Tiles do Valhalla já existem em $VALHALLA_DIR (pulando)"
else
  docker run --rm \
    -v "$PWD/$VALHALLA_DIR:/custom_files" \
    -v "$PWD/$PBF_FILE:/data/$GEO_NAME.osm.pbf:ro" \
    ghcr.io/valhalla/valhalla:latest \
    valhalla_build_tiles -c /custom_files/valhalla.json "/data/$GEO_NAME.osm.pbf"
  # Extract (.tar) de leitura rápida — o serviço usa tile_extract se existir.
  docker run --rm \
    -v "$PWD/$VALHALLA_DIR:/custom_files" \
    ghcr.io/valhalla/valhalla:latest \
    valhalla_build_extract -c /custom_files/valhalla.json
  echo "Tiles do Valhalla prontos: $VALHALLA_DIR/valhalla_tiles.tar"
fi

# ---------------------------------------------------------------------------
log "3/3 Mosaico vetorial (.mbtiles) para o TileServer GL"
if [[ -s "$MBTILES_FILE" ]]; then
  echo "Já existe: $MBTILES_FILE (pulando)"
else
  # Planetiler (build OpenMapTiles) compila o schema OpenMapTiles direto do
  # .pbf. Na primeira execução baixa os assets auxiliares do perfil
  # OpenMapTiles (Natural Earth, água, lagos) para o cache montado no host.
  # No modo região, --bounds limita a saída à GEO_BBOX: o extrato pode conter
  # nodes distantes (reparo de ways longos que cruzam a borda) e sem isso o
  # metadata de bounds do .mbtiles sai errado.
  BOUNDS_ARGS=()
  [[ -z "${GEO_OSM_URL:-}" ]] && BOUNDS_ARGS=("--bounds=$GEO_BBOX")
  docker run --rm \
    -v "$PWD/$PBF_FILE:/data/input.osm.pbf:ro" \
    -v "$PWD/$OSM_DIR/.planetiler:/cache" \
    -v "$PWD/$TILESERVER_DIR:/data/out" \
    webgeoservices/planetiler-openmaptiles:latest \
    --osm-path=/data/input.osm.pbf \
    "${BOUNDS_ARGS[@]}" \
    --output=/data/out/"$GEO_NAME".mbtiles \
    --download_dir=/cache/sources \
    --tmpdir=/cache/tmp \
    --force=true \
    --download=true
  echo "Mosaico pronto: $MBTILES_FILE ($(du -h "$MBTILES_FILE" | cut -f1))"
fi

log "Concluído. Suba a stack com: docker compose -f docker-compose.yml -f docker-compose.override.yml up -d"

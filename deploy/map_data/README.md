# Dados geográficos de DEPLOY (gerados)

Conteúdo desta pasta (ver `deploy/prepare-geo-data.sh`):

```
map_data/
├── osm/                        # baixado/recortado pelo script (gitignored)
│   ├── _fonte/                 # região-fonte do Geofabrik em cache (~427 MB)
│   ├── *.osm.pbf               # extrato da região (default: metropole-poa)
│   ├── *.fonte                 # carimbo: fonte+bbox usadas na geração
│   └── .planetiler/            # cache de assets do Planetiler (Natural Earth etc.)
├── valhalla/                   # configs versionadas + tiles gerados (gitignored)
│   ├── valhalla.json           # config do motor de rotas (versionado)
│   ├── valhalla_tiles/         # tiles compilados (gerado)
│   └── valhalla_tiles.tar      # extract de leitura rápida (gerado)
├── vroom/
│   └── config.yml              # integração VROOM <-> Valhalla (versionado)
└── tileserver/
    ├── config.json                 # config do TileServer GL (versionado)
    ├── metropole-poa-style.json    # estilo MapLibre do fundo do mapa (versionado)
    └── metropole-poa.mbtiles       # mosaico vetorial OpenMapTiles (gerado)
```

## Região padrão: metropolitana norte da RMPA

O extrato padrão cobre **Porto Alegre, São Leopoldo, Novo Hamburgo, Canoas,
Gravataí** e entorno (bbox `-51.40,-30.20,-50.95,-29.55`), permitindo rotas e
otimizações **intermunicipais**. É recortado do extrato Sul do Geofabrik
(PR+SC+RS, ~427 MB) com `osmium`, que fica em cache em `osm/_fonte/`.

## Provisionando

Pré-requisito (só na primeira vez, no host):

```bash
sudo apt-get install -y osmium-tool
```

```bash
cd deploy
./prepare-geo-data.sh
```

- **Idempotente**: o carimbo `osm/<GEO_NAME>.fonte` guarda a fonte+bbox usadas;
  se você mudar `GEO_BBOX`/`GEO_OSM_URL`, o extrato e **todos os derivados**
  (tiles do Valhalla + `.mbtiles`) são regenerados sozinhos.
- `GEO_FORCE=1 ./prepare-geo-data.sh` regenera mesmo sem mudança.
- Tempos neste host (1 CPU, 3,8 GB RAM): download ~40 s, recorte+reparo
  ~3 min, Valhalla ~1 min, Planetiler ~4 min.

Trocar a região:

```bash
# outra área (minlon,minlat,maxlon,maxlat) do mesmo Sul em cache:
GEO_BBOX=-51.50,-30.30,-50.90,-29.50 ./prepare-geo-data.sh

# extrato pronto de outra cidade (ex.: BBBike), sem recorte:
GEO_OSM_URL=<url-do-pbf> GEO_NAME=<cidade> ./prepare-geo-data.sh
```

## Serviços (dev)

| Serviço    | Imagem                            | Via Caddy (dev)             |
|------------|-----------------------------------|-----------------------------|
| `router`   | ghcr.io/valhalla/valhalla:latest   | http://routes.localhost:8081|
| `optimizer`| ghcr.io/vroom-project/vroom-docker | http://optimizer.localhost:8081 |
| `tiles`    | maptiler/tileserver-gl            | http://tiles.localhost:8081 |

> **Porta do Caddy em dev:** 8081 (8443 para HTTPS). O host deste ambiente já
> roda o Caddy de produção (systemd `pdv-caddy`) nas 80/443 — por isso o
> override publica 8081/8443. Em máquina limpa, troque de volta no
> `docker-compose.override.yml`.

Smoke test manual (sem mapa) — formatos validados:

```bash
# Nota: use -G + --data-urlencode nas URLs com JSON — o curl rejeita { } cru
# na URL (interpreta como globbing).

# Valhalla: rota INTERMUNICIPAL (Centro POA -> Novo Hamburgo)
curl -G 'http://routes.localhost:8081/route' \
  --data-urlencode 'json={"locations":[{"lat":-30.039,"lon":-51.225},{"lat":-29.763,"lon":-51.134}],"costing":"auto"}'

# Valhalla: matriz de distâncias (é o que o VROOM consome)
curl -G 'http://routes.localhost:8081/sources_to_targets' \
  --data-urlencode 'json={"sources":[{"lat":-30.039,"lon":-51.225}],"targets":[{"lat":-29.763,"lon":-51.134}],"costing":"auto"}'

# VROOM: jobs em 3 cidades + 1 veículo (usa o Valhalla p/ matriz).
# IMPORTANTE: `jobs` (não `services`) e `profile: "auto"` — o VROOM repassa o
# profile como costing ao Valhalla, e o Valhalla não conhece "car".
curl -X POST http://optimizer.localhost:8081/ -H 'Content-Type: application/json' -d '{
  "vehicles": [{"id": 1, "profile": "auto", "start": [-51.225, -30.039], "end": [-51.225, -30.039]}],
  "jobs": [
    {"id": 1, "location": [-51.230, -30.035]},
    {"id": 2, "location": [-51.094, -29.695]},
    {"id": 3, "location": [-51.134, -29.763]}
  ]}'

# TileServer: data descriptor, estilo e tiles (z12)
curl http://tiles.localhost:8081/data/metropole-poa.json
curl http://tiles.localhost:8081/styles/metropole-poa/style.json
curl -o /dev/null -w '%{http_code} %{size_download}\n' http://tiles.localhost:8081/data/metropole-poa/12/1465/2406.pbf   # POA
curl -o /dev/null -w '%{http_code} %{size_download}\n' http://tiles.localhost:8081/data/metropole-poa/12/1466/2402.pbf   # NH/SL
```

Página visual: **http://geo.localhost:8081** — cenário de **entregas
simuladas**: 1 loja no Centro de POA + 7 pedidos fictícios espalhados em POA,
Canoas, Gravataí, São Leopoldo e Novo Hamburgo. Botões: despacho VROOM
(roteiro com ordem/km/ETA por parada), rota direta loja→cliente no Valhalla
(vermelha, para comparar) e "novo pedido" que reotimiza a sequência. Sem
backend: tudo estático + os 3 serviços via Caddy.

De fora do servidor: libere a porta 8081 no firewall e adicione no seu
`/etc/hosts` (ou `C:\Windows\System32\drivers\etc\hosts`):

```
<ip-do-servidor> geo.localhost routes.localhost tiles.localhost optimizer.localhost
```

## Limitações do estilo (dev)

O estilo `metropole-poa-style.json` não tem camadas de texto/labels porque o
TileServer GL dev não serve pilha de fontes (glyphs). Para labels depois:
baixar fontes OpenMapTiles em `tileserver/fonts/` e adicionar camadas `symbol`
com `glyphs: "http://tiles.localhost:8081/fonts/{fontstack}/{range}.pbf"`.

## Notas de implementação (armadilhas encontradas)

- **osmium (recorte)**: o default `complete_ways` estoura a RAM em host pequeno
  (mantém um bitmap por ID de node ≈ 1,5 GB + índice de ways → OOM em 3,8 GB).
  O script usa `simple` e **repara** as referências pendentes da borda com
  `check-refs` → `getid` (a partir da região-fonte) → `merge`.
- **osmium**: `check-refs` sai com código **1** quando encontra refs
  pendentes — com `set -e` no script, trate com `|| true` antes de reparar.
  E nem toda ref é reparável: ways podem referenciar nodes já **apagados do
  OSM** (ex.: ~300 no extrato do Sul) — isso não existe em nenhuma fonte e o
  Valhalla/Planetiler seguem sem essas ways pontuais.
- **Bounds do .mbtiles**: o reparo acima puxa nodes de ways longos que cruzam
  a borda (limites/ferrovias antigas) — alguns centenas de km fora da bbox.
  Inofensivos para rota, mas sem `--bounds` no Planetiler o metadata de
  bounds do `.mbtiles` sai errado (Sul inteiro). O script passa `--bounds`
  automaticamente no modo região.
- **osmium**: detecta o formato de saída pelo **nome do arquivo** — temporários
  precisam de sufixo `.osm.pbf`, senão: "Could not detect file format".
- **Fontes de extrato**: o Geofabrik publica por estado/região (o do Sul =
  PR+SC+RS, `brazil/sul-latest.osm.pbf`, ~427 MB); o BBBike só tem grandes
  cidades (não há São Leopoldo/Novo Hamburgo) e o extract de POA do BBBike
  termina em lat −29,94 (não cobre SL/NH).
- **Valhalla**: usar `ghcr.io/valhalla/valhalla:latest` (3.9.x) — o
  `valhalla/valhalla:run-latest` do Docker Hub está congelado na 3.3.0 (2023)
  e exige config com formato antigo (`ip`/`port` em vez de `listen`).
- **logging**: a seção `logging` de topo é **plana** (`{"type": "std_out"}`,
  sem nó `default`); tipos válidos: `std_out`, `std_err`, `file`.
- **VROOM**: a imagem oficial é `vroom-docker` (vroom-express + vroom), não
  `vroom`; config em `/conf/config.yml` no formato `cliArgs`/`routingServers`.
- **TileServer GL**: flag é `-c/--config` (não `--configFile`); no estilo,
  `mbtiles://<id>` é substituído pela URL pública dinâmica (host+porta).
- **CORS em dev**: POST JSON do navegador dispara preflight `OPTIONS`; o
  `Caddyfile.dev` responde `204` localmente (`@cors_preflight`) nos blocos de
  routes/optimizer/tiles em vez de repassar ao serviço.
- **curl + JSON na URL**: o curl 8.x rejeita `{ }` cru ("nested brace in
  URL" — interpreta como globbing). Use `-G --data-urlencode 'json={...}'`.

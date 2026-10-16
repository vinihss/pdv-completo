# Mapas locais (OSM + OSRM + PostGIS)

Stack opcional e auto-hospedada para desenvolvimento/instalações próprias. O mapa base usa OpenStreetMap; o uso de dados OSM exige atribuição visível a © OpenStreetMap contributors e observância da ODbL. A stack não chama Google Maps nem Mapbox.

## Preparar dados (uma vez por região)

Escolha um extrato compatível com a área real de operação. Os exemplos usam América do Sul; regiões menores reduzem muito armazenamento e tempo de importação.

```bash
cd deploy/maps
mkdir -p data tile-data
export PBF_URL='https://download.geofabrik.de/south-america-latest.osm.pbf'
export PBF_FILE='south-america-latest.osm.pbf'
curl -L "$PBF_URL" -o "data/$PBF_FILE"
```

### OSRM (perfil de carro)

`osrm-extract` com `car.lua` inclui restrições e regras rodoviárias de carro. Para roteamento de motocicleta, o perfil precisa ser revisado/testado para regras locais; `car.lua` é aproximação, não um perfil especializado. Os artefatos `.osrm*` ficam no volume `data/`.

```bash
docker run --rm -t -v "$PWD/data:/data" osrm/osrm-backend:latest \
  osrm-extract -p /opt/car.lua "/data/$PBF_FILE"
docker run --rm -t -v "$PWD/data:/data" osrm/osrm-backend:latest \
  osrm-partition "/data/${PBF_FILE%.osm.pbf}.osrm"
docker run --rm -t -v "$PWD/data:/data" osrm/osrm-backend:latest \
  osrm-customize "/data/${PBF_FILE%.osm.pbf}.osrm"
```

### Tiles raster locais

Importe o mesmo PBF no volume do renderizador (o primeiro import pode levar horas e ocupar dezenas de GB, especialmente para extratos continentais):

```bash
docker run --rm -e THREADS=4 -e "DOWNLOAD_PBF=https://download.geofabrik.de/south-america-latest.osm.pbf" \
  -v "$PWD/tile-data:/data" overv/openstreetmap-tile-server:2.3.0 import
```

## Iniciar e configurar o backend

```bash
OSRM_REGION=south-america-latest docker compose up -d
```

- OSRM: `http://localhost:5001` (dentro do backend em Compose, use `http://osrm:5000`). Para o serviço HTTP OSRM, Docker publica host port `5001` para container port `5000`.
- Tiles: `http://localhost:8080/tile/{z}/{x}/{y}.png`.
- A imagem de tiles contém o banco de dados renderizado no volume `tile-data`; não use em paralelo consumidores de tiles públicos sem a atribuição exigida.
- Para apontar o backend: defina `OSRM_URL=http://osrm:5000` se o backend fizer parte da mesma rede Docker, ou `OSRM_URL=http://localhost:5001` ao rodar Node no host. Em Compose separado, conecte os serviços à mesma rede Docker.

## PostgreSQL/PostGIS

A migration `backend/migrations/0011_delivery_gis.sql` instala a extensão no banco PostgreSQL existente e cria os índices geométricos por schema de tenant. O servidor PostgreSQL precisa ter PostGIS instalado (por exemplo, imagem `postgis/postgis`); a instrução `CREATE EXTENSION` não instala o pacote do SO. Aplique pelo runner normal do backend (`npm run db:migrate`) em instalação local. Não execute contra produção sem seu procedimento operacional autorizado.

## API GIS

Rotas autenticadas de gerente: `GET/POST /delivery-regions`, `POST /delivery-regions/deliveries/:id/coordinate` e `POST /delivery-regions/:id/route`. A coordenada de uma entrega atribui `region_id` via `ST_Contains`: no checkout atual, isso ocorre automaticamente quando o endereço salvo já tem latitude/longitude; entregas/endereço sem coordenadas podem ser georreferenciados pelo endpoint `POST /delivery-regions/deliveries/:id/coordinate`. `POST /courier/location` mantém seu fluxo atual e agora atualiza também a geometria espacial/região do entregador. O gateway existente continua sendo o canal realtime; o ping mantém o evento de localização atual.

O endpoint chama o serviço OSRM **Trip**, adequado para uma sequência heurística de paradas; não é um solver VRP com capacidade de veículo, janelas de tempo, múltiplos veículos ou otimização comercial. A rota é aberta (sem retorno ao depósito) e limita-se a 100 pontos por chamada.

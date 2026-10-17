
#sudo chown -R $USER:$USER ./data
#wget -P ./data https://geofabrik.de
# Ou usando curl se preferir:
# curl -L https://geofabrik.de -o ./data/south-america-latest.osm.pbf

# 1. Extração dos dados (Gera o ficheiro .osrm e estruturas base)
docker run -t -v "$(pwd)/data:/data" osrm/osrm-backend:latest osrm-extract -p /opt/car.lua /data/south-america-latest.osm.pbf

# 2. Particionamento (Obrigatório para o algoritmo MLD que especificou)
docker run -t -v "$(pwd)/data:/data" osrm/osrm-backend:latest osrm-partition /data/south-america-latest.osrm

# 3. Customização (Gera as células de velocidade e o ficheiro de manobras em falta)
docker run -t -v "$(pwd)/data:/data" osrm/osrm-backend:latest osrm-customize /data/south-america-latest.osrm

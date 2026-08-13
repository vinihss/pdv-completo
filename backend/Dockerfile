# ============================================================
# Backend PDV — imagem de produção
# ============================================================
FROM node:22-slim AS build
WORKDIR /app

# node-gyp (usado pelo better-sqlite3) precisa de python3 + build tools
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- imagem final, sem ferramentas de build ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# Volume onde o SQLite persiste — monte um volume nomeado ou bind mount aqui
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "dist/http/server.js"]
